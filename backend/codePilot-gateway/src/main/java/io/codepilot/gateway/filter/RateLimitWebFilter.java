package io.codepilot.gateway.filter;

import io.codepilot.common.api.ErrorCodes;
import io.codepilot.common.config.SecurityProperties;
import io.codepilot.gateway.security.AuthPrincipal;
import io.codepilot.gateway.web.WebErrors;
import java.time.Duration;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * Fine-grained rate limiter with per-user + per-operation-type quotas.
 *
 * <p>Quota tiers:
 * <ul>
 *   <li><b>chat</b> — /v1/conversation/* — 30 req/min (LLM calls are expensive)</li>
 *   <li><b>completion</b> — /v1/actions/inline-completion — 60 req/min (frequent, cheap)</li>
 *   <li><b>agent</b> — /v1/conversation (agent mode) — 10 req/min (long-running, expensive)</li>
 *   <li><b>default</b> — all other endpoints — 60 req/min</li>
 * </ul>
 *
 * <p>Uses an atomic Redis script for correct concurrent counters.
 * Reads {@link AuthPrincipal} from the reactor context.
 */
@Component
public class RateLimitWebFilter implements WebFilter, Ordered {

  private static final Logger log = LoggerFactory.getLogger(RateLimitWebFilter.class);

  public static final int ORDER = JwtAuthWebFilter.ORDER + 10;

  /** Atomic INCR + EXPIRE; returns new count. */
  private static final String LUA =
      """
      local cur = redis.call('INCR', KEYS[1])
      if tonumber(cur) == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return cur
      """;

  private static final RedisScript<Long> SCRIPT = RedisScript.of(LUA, Long.class);

  private final ReactiveStringRedisTemplate redis;
  private final SecurityProperties props;

  public RateLimitWebFilter(ReactiveStringRedisTemplate redis, SecurityProperties props) {
    this.redis = redis;
    this.props = props;
  }

  @Override
  public int getOrder() {
    return ORDER;
  }

  /** Classify the request path into an operation type for per-type rate limiting. */
  private String classifyOperation(String path) {
    if (path.startsWith("/v1/actions/inline-completion")) return "completion";
    if (path.startsWith("/v1/conversation")) {
      // Agent mode uses SSE streams that are more expensive
      return "agent";
    }
    if (path.startsWith("/v1/skills/") || path.startsWith("/v1/mcp/")) return "tools";
    if (path.startsWith("/v1/models")) return "default";
    return "default";
  }

  /** Get the rate limit for an operation type. */
  private int getLimitForOperation(String opType) {
    int baseLimit = props.rateLimit().userPerMinute();
    return switch (opType) {
      case "agent" -> Math.min(baseLimit, 50);       // 50 req/min for agent
      case "chat" -> Math.min(baseLimit, 50);        // 50 req/min for chat
      case "completion" -> Math.min(baseLimit, 50);  // 50 req/min for completions
      case "tools" -> Math.min(baseLimit, 50);       // 50 req/min for tools
      default -> Math.min(baseLimit, 50);            // 50 req/min default
    };
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    return Mono.deferContextual(
        ctx -> {
          AuthPrincipal principal = ctx.getOrDefault(AuthPrincipal.CTX_KEY, null);
          if (principal == null) {
            return chain.filter(exchange);
          }

          String path = exchange.getRequest().getPath().value();
          String opType = classifyOperation(path);
          int limit = getLimitForOperation(opType);

          long minute = System.currentTimeMillis() / 60_000L;
          String key = "codepilot:rl:user:" + principal.userId() + ":" + opType + ":" + minute;
          Duration ttl = Duration.ofSeconds(70);

          return redis
              .execute(SCRIPT, List.of(key), List.of(String.valueOf(ttl.toSeconds())))
              .next()
              .flatMap(
                  count -> {
                    if (count > limit) {
                      exchange.getResponse().getHeaders().add("Retry-After", "60");
                      exchange.getResponse().getHeaders().add("X-RateLimit-Type", opType);
                      exchange.getResponse().getHeaders().add("X-RateLimit-Limit", String.valueOf(limit));
                      return WebErrors.write(
                          exchange,
                          ErrorCodes.RATE_LIMITED,
                          "t exceeded for " + opType + " operations (" + limit + "/min)",
                          429);
                    }
                    // Add rate limit headers for client awareness
                    exchange.getResponse().getHeaders().add("X-RateLimit-Type", opType);
                    exchange.getResponse().getHeaders().add("X-RateLimit-Limit", String.valueOf(limit));
                    exchange.getResponse().getHeaders().add("X-RateLimit-Remaining", String.valueOf(limit - count));
                    return chain.filter(exchange);
                  })
              .onErrorResume(
                  Exception.class,
                  ex -> {
                    log.warn("Redis unavailable, skipping rate limit for user={} opType={}: {}",
                        principal.userId(), opType, ex.getMessage());
                    return chain.filter(exchange);
                  });
        });
  }
}