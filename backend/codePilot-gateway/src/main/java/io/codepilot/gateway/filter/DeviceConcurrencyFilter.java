package io.codepilot.gateway.filter;

import java.time.Duration;
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

/**
 * Limits concurrent SSE streams per device to prevent abuse. Each active /conversation/run request
 * increments a Redis counter keyed by device ID. The counter is decremented when the stream
 * completes or the filter chain exits.
 */
@Component
@Order(50)
public class DeviceConcurrencyFilter implements WebFilter {

  private static final Logger log = LoggerFactory.getLogger(DeviceConcurrencyFilter.class);

  private final ReactiveStringRedisTemplate redis;
  private final int maxConcurrent;

  public DeviceConcurrencyFilter(
      ReactiveStringRedisTemplate redis,
      @Value("${codepilot.rate-limit.device-concurrent-streams:3}") int maxConcurrent) {
    this.redis = redis;
    this.maxConcurrent = maxConcurrent;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String path = exchange.getRequest().getPath().value();
    if (!path.contains("/conversation/run")) {
      return chain.filter(exchange);
    }

    String deviceId = exchange.getRequest().getHeaders().getFirst("X-Device-Id");
    if (deviceId == null || deviceId.isBlank()) {
      return chain.filter(exchange);
    }

    String key = "cp:stream:device:" + deviceId;

    return redis
        .opsForValue()
        .increment(key)
        .flatMap(
            count -> {
              if (count == 1L) {
                // Set TTL on first increment (safety net: 10 min max stream lifetime)
                return redis.expire(key, Duration.ofMinutes(10)).thenReturn(count);
              }
              return Mono.just(count);
            })
        .flatMap(
            count -> {
              if (count > maxConcurrent) {
                // Over limit → decrement and reject
                return redis
                    .opsForValue()
                    .decrement(key)
                    .then(
                        Mono.defer(
                            () -> {
                              exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
                              exchange
                                  .getResponse()
                                  .getHeaders()
                                  .add("X-RateLimit-Reason", "device-concurrent-streams");
                              return exchange.getResponse().setComplete();
                            }));
              }
              // Proceed and decrement on completion
              return chain
                  .filter(exchange)
                  .doFinally(signal -> redis.opsForValue().decrement(key).subscribe());
            })
        .onErrorResume(
            Exception.class,
            ex -> {
              log.warn(
                  "Redis unavailable, skipping device concurrency check for device={}: {}",
                  deviceId,
                  ex.getMessage());
              return chain.filter(exchange);
            });
  }
}
