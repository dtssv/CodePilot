package io.codepilot.gateway.filter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;

/**
 * Enforces a daily token quota per user. Token usage (prompt + completion) is tracked in a Redis
 * hash keyed by user ID + date. When the quota is exceeded, returns 429.
 *
 * <p>Token counts are submitted by the ConversationService after each model call via
 * {@link TokenQuotaFilter#recordUsage(String, long)}.
 */
@Component
@Order(51)
public class TokenQuotaFilter implements WebFilter {

  private static final Logger log = LoggerFactory.getLogger(TokenQuotaFilter.class);
  private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

  private final ReactiveStringRedisTemplate redis;
  private final long dailyQuota;

  public TokenQuotaFilter(
      ReactiveStringRedisTemplate redis,
      @Value("${codepilot.rate-limit.daily-token-quota:500000}") long dailyQuota) {
    this.redis = redis;
    this.dailyQuota = dailyQuota;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String path = exchange.getRequest().getPath().value();
    if (!path.contains("/conversation/")) {
      return chain.filter(exchange);
    }

    String userId = exchange.getRequest().getHeaders().getFirst("X-User-Id");
    if (userId == null || userId.isBlank()) {
      return chain.filter(exchange);
    }

    String key = quotaKey(userId);

    return redis.opsForHash().get(key, "total")
        .defaultIfEmpty("0")
        .flatMap(val -> {
          long used = Long.parseLong(val.toString());
          if (used >= dailyQuota) {
            log.info("Token quota exceeded for user={} used={} quota={}", userId, used, dailyQuota);
            exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
            exchange.getResponse().getHeaders().add("X-RateLimit-Reason", "daily-token-quota");
            exchange.getResponse().getHeaders().add("X-RateLimit-Used", String.valueOf(used));
            exchange.getResponse().getHeaders().add("X-RateLimit-Limit", String.valueOf(dailyQuota));
            return exchange.getResponse().setComplete();
          }
          return chain.filter(exchange);
        })
        .onErrorResume(
            Exception.class,
            ex -> {
              log.warn("Redis unavailable, skipping token quota check for user={}: {}", userId, ex.getMessage());
              return chain.filter(exchange);
            });
  }

  /**
   * Record token usage for a user. Called after each model response. Thread-safe via Redis HINCRBY.
   */
  public Mono<Long> recordUsage(String userId, long tokens) {
    String key = quotaKey(userId);
    return redis.opsForHash().increment(key, "total", tokens)
        .flatMap(newTotal -> {
          // Set expiry to end of day + 1 hour (safety margin)
          return redis.expire(key, Duration.ofHours(25)).thenReturn(newTotal);
        });
  }

  private String quotaKey(String userId) {
    String today = LocalDate.now().format(DATE_FMT);
    return "cp:quota:" + userId + ":" + today;
  }
}