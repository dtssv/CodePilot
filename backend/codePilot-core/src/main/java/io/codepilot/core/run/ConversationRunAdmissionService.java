package io.codepilot.core.run;

import io.codepilot.common.api.ErrorCodes;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Cluster-wide admission for agent conversation runs. Uses Redis counters so new runs are rejected
 * with HTTP 429 before rows are inserted into {@code conversation_runs}.
 */
@Service
public class ConversationRunAdmissionService {

  private static final Logger log = LoggerFactory.getLogger(ConversationRunAdmissionService.class);

  private static final String KEY_GLOBAL_QUEUED = "codepilot:admission:queued:global";
  private static final String KEY_GLOBAL_RUNNING = "codepilot:admission:running:global";

  private static String keyUserQueued(String userId) {
    return "codepilot:admission:queued:user:" + userId;
  }

  private static String keyUserRunning(String userId) {
    return "codepilot:admission:running:user:" + userId;
  }

  /** Atomically reject or increment queued counters. Returns 1 if admitted, 0 if rejected. */
  private static final String LUA_TRY_ENQUEUE =
      """
      local gq = tonumber(redis.call('GET', KEYS[1]) or '0')
      local gr = tonumber(redis.call('GET', KEYS[2]) or '0')
      local uq = tonumber(redis.call('GET', KEYS[3]) or '0')
      local ur = tonumber(redis.call('GET', KEYS[4]) or '0')
      local maxGq = tonumber(ARGV[1])
      local maxGr = tonumber(ARGV[2])
      local maxUq = tonumber(ARGV[3])
      local maxUr = tonumber(ARGV[4])
      local ttl = tonumber(ARGV[5])
      if gq >= maxGq or gr >= maxGr or uq >= maxUq or ur >= maxUr then
        return 0
      end
      redis.call('INCR', KEYS[1])
      redis.call('INCR', KEYS[3])
      redis.call('EXPIRE', KEYS[1], ttl)
      redis.call('EXPIRE', KEYS[3], ttl)
      return 1
      """;

  private static final RedisScript<Long> SCRIPT_TRY_ENQUEUE =
      RedisScript.of(LUA_TRY_ENQUEUE, Long.class);

  private final ReactiveStringRedisTemplate redis;
  private final ConversationRunAdmissionProperties props;

  public ConversationRunAdmissionService(
      ReactiveStringRedisTemplate redis, ConversationRunAdmissionProperties props) {
    this.redis = redis;
    this.props = props;
  }

  public boolean isEnabled() {
    return props.isEnabled();
  }

  public int retryAfterSeconds() {
    return props.getRetryAfterSeconds();
  }

  /** Snapshot for plugin probe (best-effort; may be slightly stale). */
  public Mono<AdmissionStatus> status(String userId) {
    if (!props.isEnabled()) {
      return Mono.just(AdmissionStatus.open());
    }
    String uid = userId != null ? userId : "anonymous";
    return Mono.zip(
            getCounter(KEY_GLOBAL_QUEUED),
            getCounter(KEY_GLOBAL_RUNNING),
            getCounter(keyUserQueued(uid)),
            getCounter(keyUserRunning(uid)))
        .map(
            t ->
                AdmissionStatus.of(
                    t.getT1(),
                    t.getT2(),
                    t.getT3(),
                    t.getT4(),
                    props));
  }

  /**
   * Try to reserve a queued slot before {@code conversation_runs} insert. Caller must invoke
   * {@link #releaseQueued} if insert fails after a successful admit.
   */
  public Mono<AdmissionDecision> tryAdmitEnqueue(String userId) {
    if (!props.isEnabled()) {
      return Mono.just(AdmissionDecision.allowedDecision());
    }
    String uid = userId != null && !userId.isBlank() ? userId : "anonymous";
    List<String> keys =
        List.of(
            KEY_GLOBAL_QUEUED,
            KEY_GLOBAL_RUNNING,
            keyUserQueued(uid),
            keyUserRunning(uid));
    List<String> args =
        List.of(
            String.valueOf(props.getMaxGlobalQueued()),
            String.valueOf(props.getMaxGlobalRunning()),
            String.valueOf(props.getMaxUserQueued()),
            String.valueOf(props.getMaxUserRunning()),
            String.valueOf(Duration.ofHours(2).toSeconds()));
    return redis
        .execute(SCRIPT_TRY_ENQUEUE, keys, args)
        .next()
        .map(
            n ->
                n != null && n == 1L
                    ? AdmissionDecision.allowedDecision()
                    : AdmissionDecision.rejected(
                        ErrorCodes.QUEUE_FULL,
                        "Agent run queue is full; retry later",
                        props.getRetryAfterSeconds()))
        .onErrorResume(
            ex -> {
              log.warn("Admission Redis unavailable, allowing enqueue: {}", ex.getMessage());
              return Mono.just(AdmissionDecision.allowedDecision());
            });
  }

  /** Queued run started executing — move from queued to running counters. */
  public Mono<Void> onRunStarted(String userId) {
    if (!props.isEnabled()) {
      return Mono.empty();
    }
    String uid = userId != null && !userId.isBlank() ? userId : "anonymous";
    return Mono.when(
            decr(KEY_GLOBAL_QUEUED),
            decr(keyUserQueued(uid)),
            incr(KEY_GLOBAL_RUNNING),
            incr(keyUserRunning(uid)))
        .then();
  }

  /** Run reached terminal state — release running slot. */
  public Mono<Void> onRunFinished(String userId) {
    if (!props.isEnabled()) {
      return Mono.empty();
    }
    String uid = userId != null && !userId.isBlank() ? userId : "anonymous";
    return Mono.when(decr(KEY_GLOBAL_RUNNING), decr(keyUserRunning(uid))).then();
  }

  /** Roll back enqueue reservation (insert failed or rejected after admit). */
  public Mono<Void> releaseQueued(String userId) {
    if (!props.isEnabled()) {
      return Mono.empty();
    }
    String uid = userId != null && !userId.isBlank() ? userId : "anonymous";
    return Mono.when(decr(KEY_GLOBAL_QUEUED), decr(keyUserQueued(uid))).then();
  }

  /** Overwrite Redis admission counters from durable DB truth (dev recovery / drift repair). */
  public Mono<Void> syncCounters(long globalQueued, long globalRunning, Map<String, long[]> perUser) {
    if (!props.isEnabled()) {
      return Mono.empty();
    }
    return Mono.when(
            setCounter(KEY_GLOBAL_QUEUED, globalQueued),
            setCounter(KEY_GLOBAL_RUNNING, globalRunning))
        .then(
            Mono.when(
                perUser.entrySet().stream()
                    .flatMap(
                        e ->
                            java.util.stream.Stream.of(
                                setCounter(keyUserQueued(e.getKey()), e.getValue()[0]),
                                setCounter(keyUserRunning(e.getKey()), e.getValue()[1])))
                    .toArray(Mono[]::new)))
        .then();
  }

  /**
   * Scans Redis for per-user admission counter keys that are NOT in the provided {@code
   * knownUsers} set, and resets them to zero. This handles stale counters left behind when the
   * server crashes — the DB may show zero queued/running runs for a user, but Redis still holds
   * the old counter value.
   */
  public Mono<Void> clearStaleUserCounters(java.util.Set<String> knownUsers) {
    if (!props.isEnabled()) {
      return Mono.empty();
    }
    return Mono.when(
            redis.keys("codepilot:admission:queued:user:*")
                .flatMap(
                    key -> {
                      String uid = extractUserIdFromKey(key, "codepilot:admission:queued:user:");
                      if (uid != null && !knownUsers.contains(uid)) {
                        log.info("Clearing stale Redis userQueued counter: key={} (user not in DB)", key);
                        return setCounter(key, 0);
                      }
                      return Mono.empty();
                    })
                .collectList()
                .then(),
            redis.keys("codepilot:admission:running:user:*")
                .flatMap(
                    key -> {
                      String uid = extractUserIdFromKey(key, "codepilot:admission:running:user:");
                      if (uid != null && !knownUsers.contains(uid)) {
                        log.info("Clearing stale Redis userRunning counter: key={} (user not in DB)", key);
                        return setCounter(key, 0);
                      }
                      return Mono.empty();
                    })
                .collectList()
                .then())
        .then();
  }

  private static String extractUserIdFromKey(String key, String prefix) {
    if (key == null || !key.startsWith(prefix)) {
      return null;
    }
    return key.substring(prefix.length());
  }

  private Mono<Void> setCounter(String key, long value) {
    long v = Math.max(0L, value);
    return redis.opsForValue().set(key, String.valueOf(v)).then();
  }

  private Mono<Long> getCounter(String key) {
    return redis.opsForValue().get(key).map(v -> v == null ? 0L : Long.parseLong(v)).defaultIfEmpty(0L);
  }

  private Mono<Long> incr(String key) {
    return redis
        .opsForValue()
        .increment(key)
        .flatMap(
            n ->
                redis
                    .expire(key, Duration.ofHours(2))
                    .thenReturn(n));
  }

  private Mono<Long> decr(String key) {
    return redis
        .opsForValue()
        .decrement(key)
        .flatMap(
            n -> {
              if (n != null && n < 0) {
                return redis.opsForValue().set(key, "0").thenReturn(0L);
              }
              return Mono.just(n != null ? n : 0L);
            });
  }

  public record AdmissionDecision(boolean allowed, int errorCode, String message, int retryAfterSec) {
    public static AdmissionDecision allowedDecision() {
      return new AdmissionDecision(true, 0, "", 0);
    }

    public static AdmissionDecision rejected(int code, String message, int retryAfterSec) {
      return new AdmissionDecision(false, code, message, retryAfterSec);
    }
  }

  public record AdmissionStatus(
      boolean admit,
      int retryAfterSec,
      long globalQueued,
      long globalRunning,
      long userQueued,
      long userRunning,
      Map<String, Integer> limits) {

    static AdmissionStatus open() {
      return new AdmissionStatus(true, 0, 0, 0, 0, 0, Map.of());
    }

    static AdmissionStatus of(
        long gq,
        long gr,
        long uq,
        long ur,
        ConversationRunAdmissionProperties props) {
      boolean ok =
          gq < props.getMaxGlobalQueued()
              && gr < props.getMaxGlobalRunning()
              && uq < props.getMaxUserQueued()
              && ur < props.getMaxUserRunning();
      return new AdmissionStatus(
          ok,
          ok ? 0 : props.getRetryAfterSeconds(),
          gq,
          gr,
          uq,
          ur,
          Map.of(
              "maxGlobalQueued", props.getMaxGlobalQueued(),
              "maxGlobalRunning", props.getMaxGlobalRunning(),
              "maxUserQueued", props.getMaxUserQueued(),
              "maxUserRunning", props.getMaxUserRunning()));
    }

    public Map<String, Object> toMap() {
      return Map.of(
          "admit", admit,
          "retryAfterSec", retryAfterSec,
          "globalQueued", globalQueued,
          "globalRunning", globalRunning,
          "userQueued", userQueued,
          "userRunning", userRunning,
          "limits", limits);
    }
  }
}
