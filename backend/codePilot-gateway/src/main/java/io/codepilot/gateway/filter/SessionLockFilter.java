package io.codepilot.gateway.filter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

import java.time.Duration;

/**
 * Ensures only ONE concurrent /conversation/run per sessionId. Uses a Redis SETNX lock with a
 * safety TTL. If the lock is already held, returns 409 Conflict. The lock is released when the
 * SSE stream completes.
 */
@Component
@Order(45)
public class SessionLockFilter implements WebFilter {

  private static final Logger log = LoggerFactory.getLogger(SessionLockFilter.class);
  private static final Duration LOCK_TTL = Duration.ofMinutes(10); // safety net

  private final ReactiveStringRedisTemplate redis;

  public SessionLockFilter(ReactiveStringRedisTemplate redis) {
    this.redis = redis;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String path = exchange.getRequest().getPath().value();
    if (!path.contains("/conversation/run") && !path.contains("/conversation/resume")) {
      return chain.filter(exchange);
    }

    // Extract sessionId from the request body is not trivial in a WebFilter with a reactive body.
    // We use the X-Session-Id header as a lightweight alternative (plugin sends it).
    String sessionId = exchange.getRequest().getHeaders().getFirst("X-Session-Id");
    if (sessionId == null || sessionId.isBlank()) {
      return chain.filter(exchange); // no lock if no session header
    }

    String lockKey = "cp:lock:agent:" + sessionId;

    return redis.opsForValue().setIfAbsent(lockKey, "1", LOCK_TTL)
        .flatMap(acquired -> {
          if (Boolean.FALSE.equals(acquired)) {
            log.info("Session lock conflict for sessionId={}", sessionId);
            exchange.getResponse().setStatusCode(HttpStatus.CONFLICT);
            exchange.getResponse().getHeaders().add("X-Lock-Reason", "session-already-running");
            return exchange.getResponse().setComplete();
          }
          // Proceed; release lock when the stream completes
          return chain.filter(exchange)
              .doFinally(signal -> redis.delete(lockKey).subscribe());
        });
  }
}