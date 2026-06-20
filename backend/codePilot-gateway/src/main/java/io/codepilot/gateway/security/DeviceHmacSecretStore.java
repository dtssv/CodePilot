package io.codepilot.gateway.security;

import java.time.Duration;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Per-device HMAC signing secrets issued at {@code POST /v1/auth/login}. The plugin signs requests
 * with {@code deviceSecret}; the gateway resolves it by {@code X-CodePilot-Device-Id}.
 */
@Component
public class DeviceHmacSecretStore {

  private static final String KEY_PREFIX = "codepilot:device:hmac:";

  private final ReactiveStringRedisTemplate redis;

  public DeviceHmacSecretStore(ReactiveStringRedisTemplate redis) {
    this.redis = redis;
  }

  public Mono<Void> store(String deviceId, String secret, Duration ttl) {
    if (deviceId == null || deviceId.isBlank() || secret == null || secret.isBlank()) {
      return Mono.empty();
    }
    return redis.opsForValue().set(KEY_PREFIX + deviceId, secret, ttl).then();
  }

  /**
   * @return empty Mono when no per-device secret is stored
   */
  public Mono<String> resolve(String deviceId) {
    if (deviceId == null || deviceId.isBlank()) {
      return Mono.empty();
    }
    return redis.opsForValue().get(KEY_PREFIX + deviceId).filter(s -> !s.isBlank());
  }
}
