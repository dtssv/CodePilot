package io.codepilot.gateway.filter;

import io.codepilot.common.api.ErrorCodes;
import io.codepilot.common.config.SecurityProperties;
import io.codepilot.gateway.security.AuthPrincipal;
import io.codepilot.gateway.web.WebErrors;
import java.time.Duration;
import java.util.List;
import org.springframework.core.Ordered;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * Per-user, fixed-window request limiter (60 req/min by default). Uses an atomic Redis script so
 * counters are correct under concurrent traffic. Reads {@link AuthPrincipal} from the reactor
 * context.
 */
@Component
public class RateLimitWebFilter implements WebFilter, Ordered {

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

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    return Mono.deferContextual(
        ctx -> {
          AuthPrincipal principal = ctx.getOrDefault(AuthPrincipal.CTX_KEY, null);
          if (principal == null) {
            // Public endpoints don't go through rate limiting; the JWT filter already enforced it.
            return chain.filter(exchange);
          }
          long minute = System.currentTimeMillis() / 60_000L;
          String key = "codepilot:rl:user:" + principal.userId() + ":" + minute;
          Duration ttl = Duration.ofSeconds(70);
          int limit = props.rateLimit().userPerMinute();

          return redis
              .execute(SCRIPT, List.of(key), List.of(String.valueOf(ttl.toSeconds())))
              .next()
              .flatMap(
                  count -> {
                    if (count > limit) {
                      exchange.getResponse().getHeaders().add("Retry-After", "60");
                      return WebErrors.write(
                          exchange,
                          ErrorCodes.RATE_LIMITED,
                          "Too many requests, please slow down",
                          429);
                    }
                    return chain.filter(exchange);
                  });
        });
  }
}