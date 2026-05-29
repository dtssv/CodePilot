package io.codepilot.core.model;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Cluster-wide load balancer for model app keys within a model group.
 * All runtime state (concurrency, RPM, TPM, circuit-breaker) is stored in Redis
 * so that multiple backend replicas share the same view.
 *
 * <h3>Redis key layout:</h3>
 * <pre>
 * codepilot:lb:concurrency:{appKeyId}     → STRING (current concurrent requests, INCR/DECR)
 * codepilot:lb:rpm:{appKeyId}:{minute}    → STRING (request count in this minute, INCR, TTL=120s)
 * codepilot:lb:tpm:{appKeyId}:{minute}    → STRING (token count in this minute, INCRBY, TTL=120s)
 * codepilot:lb:breaker:{appKeyId}         → HASH  { state, failures, openedAt }, TTL=2h
 * </pre>
 *
 * <h3>Selection strategy (multi-dimension):</h3>
 * <ol>
 *   <li><b>Circuit-breaker</b>: skip keys in OPEN state</li>
 *   <li><b>Concurrency limit</b>: skip keys at max concurrency</li>
 *   <li><b>RPM limit</b>: skip keys exceeding requests-per-minute</li>
 *   <li><b>TPM limit</b>: skip keys exceeding tokens-per-minute</li>
 *   <li><b>Weighted least-load + priority</b>: pick lowest load/weight, break ties by priority</li>
 * </ol>
 *
 * <h3>Circuit-breaker states:</h3>
 * CLOSED → OPEN (after 5 consecutive failures) → HALF-OPEN (after 60s cooldown) → CLOSED (probe success)
 */
@Component
public class AppKeyLoadBalancer {

  private static final Logger log = LoggerFactory.getLogger(AppKeyLoadBalancer.class);

  static final int DEFAULT_FAILURE_THRESHOLD = 5;
  static final Duration DEFAULT_OPEN_DURATION = Duration.ofSeconds(60);
  private static final Duration RATE_KEY_TTL = Duration.ofSeconds(120);
  private static final Duration BREAKER_KEY_TTL = Duration.ofHours(2);
  private static final Duration CONCURRENCY_KEY_TTL = Duration.ofHours(2);

  private static final String KEY_PREFIX = "codepilot:lb:";

  private final NamedParameterJdbcTemplate jdbc;
  private final StringRedisTemplate redis;

  public AppKeyLoadBalancer(NamedParameterJdbcTemplate jdbc, StringRedisTemplate redis) {
    this.jdbc = jdbc;
    this.redis = redis;
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * Selects the best available appKey for the given model group.
   * Returns null if no eligible appKey exists.
   */
  public UUID selectAppKey(UUID groupId) {
    List<AppKeyCandidate> candidates = fetchEnabledAppKeys(groupId);
    if (candidates.isEmpty()) {
      log.warn("No enabled app keys found for model group: {}", groupId);
      return null;
    }

    AppKeyCandidate best = null;
    double bestScore = Double.MAX_VALUE;

    for (AppKeyCandidate c : candidates) {
      // 1. Circuit-breaker check
      if (!isRequestAllowed(c.id)) {
        log.debug("AppKey {} skipped: circuit-breaker OPEN", c.id);
        continue;
      }

      // 2. Concurrency limit check
      int currentLoad = getLoad(c.id);
      if (c.maxConcurrency > 0 && currentLoad >= c.maxConcurrency) {
        log.debug("AppKey {} skipped: concurrency {}/{}", c.id, currentLoad, c.maxConcurrency);
        continue;
      }

      // 3. RPM limit check
      if (c.rpmLimit > 0 && getRpm(c.id) >= c.rpmLimit) {
        log.debug("AppKey {} skipped: RPM {}/{}", c.id, getRpm(c.id), c.rpmLimit);
        continue;
      }

      // 4. TPM limit check
      if (c.tpmLimit > 0 && getTpm(c.id) >= c.tpmLimit) {
        log.debug("AppKey {} skipped: TPM {}/{}", c.id, getTpm(c.id), c.tpmLimit);
        continue;
      }

      // 5. Weighted least-load score (lower is better)
      double score = (double) currentLoad / Math.max(c.weight, 1);

      // 6. Tie-break: prefer higher priority
      double priorityBonus = c.priority * 0.001;
      score -= priorityBonus;

      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best != null) {
      log.info("Selected appKey {} for group {} (load={}, weight={}, priority={}, score={})",
          best.id, groupId, getLoad(best.id), best.weight, best.priority,
          String.format("%.4f", bestScore));
    } else {
      log.warn("No eligible appKey for group {} (all filtered by limits or circuit-breaker)", groupId);
    }
    return best != null ? best.id : null;
  }

  /** Increments concurrency and RPM counters (call before request). */
  public void acquire(UUID appKeyId) {
    String concurrencyKey = concurrencyKey(appKeyId);
    redis.opsForValue().increment(concurrencyKey);
    redis.expire(concurrencyKey, CONCURRENCY_KEY_TTL);

    String rpmKey = rpmKey(appKeyId);
    redis.opsForValue().increment(rpmKey);
    redis.expire(rpmKey, RATE_KEY_TTL);
  }

  /** Decrements concurrency counter (call after request completes). */
  public void release(UUID appKeyId) {
    String concurrencyKey = concurrencyKey(appKeyId);
    // Lua: DECR but never go below 0
    DefaultRedisScript<Long> script = new DefaultRedisScript<>(
        "local v = redis.call('DECR', KEYS[1]); if v < 0 then redis.call('SET', KEYS[1], '0'); return 0; else return v; end",
        Long.class);
    redis.execute(script, List.of(concurrencyKey));
  }

  /** Records a successful response and its token usage. Resets circuit-breaker failures. */
  public void recordSuccess(UUID appKeyId, int tokensUsed) {
    onCircuitBreakerSuccess(appKeyId);
    if (tokensUsed > 0) {
      String tpmKey = tpmKey(appKeyId);
      redis.opsForValue().increment(tpmKey, tokensUsed);
      redis.expire(tpmKey, RATE_KEY_TTL);
    }
  }

  /** Records a failed response. May trigger circuit-breaker. */
  public void recordFailure(UUID appKeyId) {
    onCircuitBreakerFailure(appKeyId);
  }

  /**
   * Records a rate-limit (429) failure. Opens the circuit-breaker immediately
   * for rate-limit errors because this appKey's quota is exhausted — no point
   * in retrying the same key until the rate window resets.
   */
  public void recordRateLimit(UUID appKeyId) {
    // ★ Open circuit-breaker immediately for rate-limit errors.
    // The appKey's per-minute/per-second quota is exhausted, so further requests
    // will also be rejected until the window resets. Opening the breaker lets
    // other appKeys (if configured) take over immediately.
    String key = breakerKey(appKeyId);
    redis.opsForHash().put(key, "state", "OPEN");
    redis.opsForHash().put(key, "failures", String.valueOf(DEFAULT_FAILURE_THRESHOLD));
    redis.opsForHash().put(key, "openedAt", String.valueOf(System.currentTimeMillis()));
    redis.expire(key, BREAKER_KEY_TTL);
    log.warn("Circuit-breaker for appKey {} OPENED immediately due to 429 rate-limit", appKeyId);
  }

  /** Gets the current concurrency for an appKey. */
  public int getLoad(UUID appKeyId) {
    String val = redis.opsForValue().get(concurrencyKey(appKeyId));
    return val != null ? Math.max(Integer.parseInt(val), 0) : 0;
  }

  /** Gets the current RPM for an appKey. */
  public int getRpm(UUID appKeyId) {
    String val = redis.opsForValue().get(rpmKey(appKeyId));
    return val != null ? Integer.parseInt(val) : 0;
  }

  /** Gets the current TPM for an appKey. */
  public long getTpm(UUID appKeyId) {
    String val = redis.opsForValue().get(tpmKey(appKeyId));
    return val != null ? Long.parseLong(val) : 0;
  }

  // ========================================================================
  // Redis key helpers
  // ========================================================================

  private String concurrencyKey(UUID id) {
    return KEY_PREFIX + "concurrency:" + id;
  }

  /** Minute-based key for RPM: includes the current minute epoch for automatic windowing. */
  private String rpmKey(UUID id) {
    long minute = System.currentTimeMillis() / 60_000;
    return KEY_PREFIX + "rpm:" + id + ":" + minute;
  }

  /** Minute-based key for TPM. */
  private String tpmKey(UUID id) {
    long minute = System.currentTimeMillis() / 60_000;
    return KEY_PREFIX + "tpm:" + id + ":" + minute;
  }

  private String breakerKey(UUID id) {
    return KEY_PREFIX + "breaker:" + id;
  }

  // ========================================================================
  // Circuit-breaker (Redis HASH based, cluster-wide)
  // ========================================================================

  /**
   * Checks if a request is allowed under the current circuit-breaker state.
   * State machine: CLOSED → OPEN → HALF-OPEN → CLOSED
   */
  private boolean isRequestAllowed(UUID appKeyId) {
    String key = breakerKey(appKeyId);
    var hash = redis.opsForHash().entries(key);

    if (hash.isEmpty()) return true; // no breaker entry = CLOSED

    String state = (String) hash.getOrDefault("state", "CLOSED");

    if ("CLOSED".equals(state)) return true;

    if ("HALF_OPEN".equals(state)) return true; // allow probe

    // OPEN — check if cooldown has elapsed
    String openedAtStr = (String) hash.get("openedAt");
    if (openedAtStr != null) {
      long openedAt = Long.parseLong(openedAtStr);
      if (System.currentTimeMillis() - openedAt >= DEFAULT_OPEN_DURATION.toMillis()) {
        // Transition to HALF-OPEN
        redis.opsForHash().put(key, "state", "HALF_OPEN");
        redis.expire(key, BREAKER_KEY_TTL);
        log.info("Circuit-breaker for appKey {} transitioned OPEN → HALF_OPEN", appKeyId);
        return true;
      }
    }
    return false;
  }

  private void onCircuitBreakerSuccess(UUID appKeyId) {
    String key = breakerKey(appKeyId);
    var hash = redis.opsForHash().entries(key);

    if (hash.isEmpty()) return; // no breaker = already healthy

    String state = (String) hash.getOrDefault("state", "CLOSED");
    if ("HALF_OPEN".equals(state)) {
      // Probe succeeded → close the breaker
      redis.opsForHash().put(key, "state", "CLOSED");
      redis.opsForHash().put(key, "failures", "0");
      redis.expire(key, BREAKER_KEY_TTL);
      log.info("Circuit-breaker for appKey {} CLOSED (probe succeeded)", appKeyId);
    } else {
      // Reset failure count on any success
      redis.opsForHash().put(key, "failures", "0");
      redis.expire(key, BREAKER_KEY_TTL);
    }
  }

  private void onCircuitBreakerFailure(UUID appKeyId) {
    String key = breakerKey(appKeyId);
    var hash = redis.opsForHash().entries(key);

    String state = (String) hash.getOrDefault("state", "CLOSED");
    int failures = Integer.parseInt((String) hash.getOrDefault("failures", "0"));
    failures++;

    if ("HALF_OPEN".equals(state)) {
      // Probe failed → re-open
      redis.opsForHash().put(key, "state", "OPEN");
      redis.opsForHash().put(key, "failures", String.valueOf(failures));
      redis.opsForHash().put(key, "openedAt", String.valueOf(System.currentTimeMillis()));
      redis.expire(key, BREAKER_KEY_TTL);
      log.warn("Circuit-breaker for appKey {} re-OPENED (probe failed)", appKeyId);
    } else if (failures >= DEFAULT_FAILURE_THRESHOLD) {
      // Threshold reached → open
      redis.opsForHash().put(key, "state", "OPEN");
      redis.opsForHash().put(key, "failures", String.valueOf(failures));
      redis.opsForHash().put(key, "openedAt", String.valueOf(System.currentTimeMillis()));
      redis.expire(key, BREAKER_KEY_TTL);
      log.warn("Circuit-breaker for appKey {} OPENED after {} consecutive failures", appKeyId, failures);
    } else {
      // Just increment failure count
      redis.opsForHash().put(key, "state", state);
      redis.opsForHash().put(key, "failures", String.valueOf(failures));
      redis.expire(key, BREAKER_KEY_TTL);
    }
  }

  // ========================================================================
  // Internal: DB query
  // ========================================================================

  private List<AppKeyCandidate> fetchEnabledAppKeys(UUID groupId) {
    String sql = """
        SELECT id, weight, max_concurrency, rpm_limit, tpm_limit, priority
        FROM model_app_keys
        WHERE group_id = :groupId AND enabled = 1
        """;
    return jdbc.query(sql, new MapSqlParameterSource("groupId", groupId.toString()),
        (rs, i) -> new AppKeyCandidate(
            UUID.fromString(rs.getString("id")),
            rs.getInt("weight"),
            rs.getInt("max_concurrency"),
            rs.getInt("rpm_limit"),
            rs.getInt("tpm_limit"),
            rs.getInt("priority")));
  }

  private record AppKeyCandidate(
      UUID id, int weight, int maxConcurrency, int rpmLimit, int tpmLimit, int priority) {}
}