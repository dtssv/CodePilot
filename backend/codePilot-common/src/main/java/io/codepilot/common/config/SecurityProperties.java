package io.codepilot.common.config;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Root security configuration. Fail-fast on missing secrets; no hidden defaults for secrets.
 *
 * <p>All durations default to values suitable for production; individual deployments may override
 * in {@code application.yml}.
 */
@Validated
@ConfigurationProperties(prefix = "codepilot.security")
public record SecurityProperties(
    @NotBlank @Size(min = 32) String jwtSecret,
    @NotBlank @Size(min = 32) String hmacSecret,
    Jwt jwt,
    Hmac hmac,
    RateLimit rateLimit) {

  public SecurityProperties {
    if (jwt == null) jwt = new Jwt(Duration.ofHours(2), Duration.ofDays(7));
    if (hmac == null) hmac = new Hmac(Duration.ofMinutes(5), Duration.ofMinutes(5));
    if (rateLimit == null) rateLimit = new RateLimit(60, 30, 600_000L);
  }

  public record Jwt(Duration accessTtl, Duration refreshTtl) {}

  /**
   * @param tsSkew maximum tolerated clock drift for {@code X-CodePilot-Ts}
   * @param nonceTtl TTL for the Redis nonce blacklist used to reject replayed requests
   */
  public record Hmac(Duration tsSkew, Duration nonceTtl) {}

  /**
   * @param userPerMinute request cap per user per minute
   * @param deviceConcurrency max concurrent streams per device
   * @param userDailyTokens daily prompt+completion token budget per user
   */
  public record RateLimit(
      @Min(1) int userPerMinute, @Min(1) int deviceConcurrency, @Min(1_000) long userDailyTokens) {}
}