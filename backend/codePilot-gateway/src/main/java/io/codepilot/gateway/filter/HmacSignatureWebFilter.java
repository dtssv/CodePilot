package io.codepilot.gateway.filter;

import io.codepilot.common.api.ErrorCodes;
import io.codepilot.common.config.SecurityProperties;
import io.codepilot.gateway.security.DeviceHmacSecretStore;
import io.codepilot.gateway.security.HmacSigner;
import io.codepilot.gateway.util.CachedBodyServerHttpRequestDecorator;
import io.codepilot.gateway.web.WebErrors;
import java.time.Clock;
import java.time.Duration;
import java.util.Set;
import org.apache.commons.lang3.StringUtils;
import org.springframework.core.Ordered;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * Validates the HMAC signature bundle on protected endpoints. Requests without a valid signature
 * are rejected with 401 / {@link ErrorCodes#UNAUTHORIZED}.
 *
 * <ol>
 *   <li>Checks clock skew via {@code X-CodePilot-Ts};
 *   <li>Rejects replays using a Redis-backed nonce blacklist;
 *   <li>Resolves the per-device HMAC secret via {@link DeviceHmacSecretStore}, falling back to the
 *       global {@code codepilot.security.hmac-secret};
 *   <li>Recomputes the HMAC signature over {@code body + '\n' + ts + '\n' + nonce}.
 * </ol>
 *
 * <p>Public endpoints (actuator, swagger, version, auth/login) are skipped.
 */
@Component
public class HmacSignatureWebFilter implements WebFilter, Ordered {

  public static final int ORDER = TraceIdWebFilter.ORDER + 10;

  private static final Set<String> PUBLIC_PATH_PREFIXES =
      Set.of(
          "/actuator",
          "/v3/api-docs",
          "/swagger-ui",
          "/webjars/",
          "/favicon.ico",
          "/v1/version",
          "/v1/auth/login",
          "/v1/auth/refresh",
          "/v1/auth/methods",
          "/v1/auth/device-code",
          "/v1/auth/device-token",
          "/admin");

  private static final int MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB

  private final SecurityProperties props;
  private final ReactiveStringRedisTemplate redis;
  private final DeviceHmacSecretStore deviceHmacSecretStore;
  private final Clock clock = Clock.systemUTC();

  /**
   * Dev token for bypassing HMAC+JWT in development builds. Set via codepilot.security.dev-token.
   */
  private final String devToken;

  public HmacSignatureWebFilter(
      SecurityProperties props,
      ReactiveStringRedisTemplate redis,
      DeviceHmacSecretStore deviceHmacSecretStore,
      @org.springframework.beans.factory.annotation.Value("${codepilot.security.dev-token:}")
          String devToken) {
    this.props = props;
    this.redis = redis;
    this.deviceHmacSecretStore = deviceHmacSecretStore;
    this.devToken = devToken.isBlank() ? null : devToken;
  }

  @Override
  public int getOrder() {
    return ORDER;
  }

  private static final String DEV_TOKEN_HEADER = "X-CodePilot-Dev-Token";

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    ServerHttpRequest req = exchange.getRequest();
    String path = req.getPath().pathWithinApplication().value();
    if (isPublic(path)) {
      return chain.filter(exchange);
    }

    // Dev token bypass: if a valid dev token header is present, skip HMAC verification
    String devToken = req.getHeaders().getFirst(DEV_TOKEN_HEADER);
    if (devToken != null && !devToken.isBlank() && isValidDevToken(devToken)) {
      return chain.filter(exchange);
    }

    var headers = req.getHeaders();
    String deviceId = headers.getFirst("X-CodePilot-Device-Id");
    String ts = headers.getFirst("X-CodePilot-Ts");
    String nonce = headers.getFirst("X-CodePilot-Nonce");
    String sig = headers.getFirst("X-CodePilot-Signature");

    if (StringUtils.isAnyBlank(deviceId, ts, nonce, sig)) {
      return WebErrors.write(exchange, ErrorCodes.UNAUTHORIZED, "Missing signature headers", 401);
    }

    long tsMillis;
    try {
      tsMillis = Long.parseLong(ts);
    } catch (NumberFormatException e) {
      return WebErrors.write(exchange, ErrorCodes.UNAUTHORIZED, "Invalid X-CodePilot-Ts", 401);
    }

    long nowMs = clock.millis();
    long skewMs = props.hmac().tsSkew().toMillis();
    if (Math.abs(nowMs - tsMillis) > skewMs) {
      return WebErrors.write(exchange, ErrorCodes.UNAUTHORIZED, "Clock skew too large", 401);
    }

    String nonceKey = "codepilot:hmac:nonce:" + deviceId + ":" + nonce;
    Duration nonceTtl = props.hmac().nonceTtl();

    return CachedBodyServerHttpRequestDecorator.wrap(req, MAX_BODY_BYTES)
        .flatMap(
            wrapped ->
                redis
                    .opsForValue()
                    .setIfAbsent(nonceKey, "1", nonceTtl)
                    .flatMap(
                        firstUse -> {
                          if (Boolean.FALSE.equals(firstUse)) {
                            return WebErrors.write(
                                exchange, ErrorCodes.UNAUTHORIZED, "Replay detected", 401);
                          }
                          return verifySignature(wrapped.bodyAsString(), ts, nonce, sig, deviceId)
                              .flatMap(
                                  valid -> {
                                    if (!valid) {
                                      return WebErrors.write(
                                          exchange,
                                          ErrorCodes.UNAUTHORIZED,
                                          "Invalid signature",
                                          401);
                                    }
                                    ServerWebExchange mutated =
                                        exchange.mutate().request(wrapped.request()).build();
                                    return chain.filter(mutated);
                                  });
                        }));
  }

  /**
   * Verifies the HMAC signature, trying the per-device secret first, falling back to the global
   * {@code codepilot.security.hmac-secret}.
   */
  private Mono<Boolean> verifySignature(
      String body, String ts, String nonce, String sig, String deviceId) {
    return deviceHmacSecretStore
        .resolve(deviceId)
        .flatMap(
            deviceSecret -> {
              var deviceSigner = new HmacSigner(deviceSecret);
              if (deviceSigner.verify(body, ts, nonce, sig)) {
                return Mono.just(true);
              }
              // Device secret didn't match; fall through to global secret
              return Mono.empty();
            })
        .switchIfEmpty(
            Mono.fromCallable(
                () -> {
                  var globalSigner = new HmacSigner(props.hmacSecret());
                  return globalSigner.verify(body, ts, nonce, sig);
                }));
  }

  private boolean isPublic(String path) {
    for (String prefix : PUBLIC_PATH_PREFIXES) {
      if (path.startsWith(prefix + "/") || path.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if the provided dev token matches the configured dev token. Uses constant-time
   * comparison to prevent timing attacks.
   */
  private boolean isValidDevToken(String token) {
    if (devToken == null || devToken.isEmpty()) return false;
    return java.security.MessageDigest.isEqual(
        token.getBytes(java.nio.charset.StandardCharsets.UTF_8),
        devToken.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  }
}
