package io.codepilot.api.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSSigner;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.text.ParseException;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;
import org.springframework.validation.annotation.Validated;
import reactor.core.publisher.Mono;

/**
 * Development-only {@link SsoVerifier}. Allows login with a username directly — no real IdP
 * needed. The ssoToken is a JWT signed with a dev-specific secret (independent of production
 * secrets).
 *
 * <p><strong>SAFETY:</strong> Only activated when {@code codepilot.security.sso.dev.enabled=true}.
 * A startup banner warning is printed. In production, this property MUST be {@code false}
 * (enforced by documentation and ops review).
 *
 * <p>The dev ssoToken JWT must contain:
 * <ul>
 *   <li>{@code sub} — username (required)
 *   <li>{@code tid} — tenant id (optional, defaults to "dev")
 *   <li>{@code did} — device id (optional, defaults to "dev-device")
 *   <li>{@code exp} — expiry (required, max 1h)
 * </ul>
 *
 * <p>For convenience, a helper method {@link #issueDevToken} is provided to generate dev tokens
 * programmatically (e.g. in tests or CLI tools).
 */
@Service
@ConditionalOnProperty(prefix = "codepilot.security.sso.dev", name = "enabled", havingValue = "true")
public class DevSsoVerifier implements SsoVerifier {

  private static final Logger log = LoggerFactory.getLogger(DevSsoVerifier.class);

  private final DevSsoProperties props;
  private final JWSSigner signer;
  private final JWSVerifier verifier;

  public DevSsoVerifier(DevSsoProperties props) throws JOSEException {
    this.props = props;
    byte[] secret = props.secret().getBytes();
    this.signer = new MACSigner(secret);
    this.verifier = new MACVerifier(secret);
    log.warn(
        "╔══════════════════════════════════════════════════════════════╗");
    log.warn(
        "║  ⚠  DEV SSO VERIFIER ACTIVE — NOT FOR PRODUCTION USE  ⚠     ║");
    log.warn(
        "╚══════════════════════════════════════════════════════════════╝");
  }

  @Override
  public Mono<VerifiedIdentity> verify(String ssoToken) {
    return Mono.fromCallable(
        () -> {
          SignedJWT jwt;
          try {
            jwt = SignedJWT.parse(ssoToken);
          } catch (ParseException e) {
            throw new IllegalArgumentException("Malformed dev SSO token");
          }
          try {
            if (!jwt.verify(verifier)) {
              throw new IllegalArgumentException("Invalid dev SSO signature");
            }
          } catch (JOSEException e) {
            throw new IllegalArgumentException("Dev SSO verification failed");
          }
          JWTClaimsSet claims;
          try {
            claims = jwt.getJWTClaimsSet();
          } catch (ParseException e) {
            throw new IllegalArgumentException("Malformed dev SSO claims");
          }

          // Dev tokens have a max TTL of 1 hour
          Date exp = claims.getExpirationTime();
          if (exp == null || exp.before(new Date())) {
            throw new IllegalArgumentException("Dev SSO token expired");
          }

          String subject = require(claims.getSubject(), "sub");
          String tenant = firstNonNull((String) claims.getClaim("tid"), "dev");
          String device = firstNonNull((String) claims.getClaim("did"), "dev-device");
          String name = firstNonNull(claims.getStringClaim("name"), subject);

          return new VerifiedIdentity(tenant, subject, name, null, device);
        });
  }

  /**
   * Issues a dev SSO token for the given username. Useful in tests and CLI tools.
   * The token is valid for {@link DevSsoProperties#tokenTtl()}.
   */
  public String issueDevToken(String username, String tenantId, String deviceId) {
    try {
      var now = Instant.now();
      var exp = now.plus(props.tokenTtl());
      JWTClaimsSet claims =
          new JWTClaimsSet.Builder()
              .subject(username)
              .claim("tid", tenantId != null ? tenantId : "dev")
              .claim("did", deviceId != null ? deviceId : "dev-device")
              .claim("name", username)
              .jwtID(UUID.randomUUID().toString())
              .issueTime(Date.from(now))
              .expirationTime(Date.from(exp))
              .build();
      SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
      jwt.sign(signer);
      return jwt.serialize();
    } catch (JOSEException e) {
      throw new IllegalStateException("Failed to sign dev token", e);
    }
  }

  private static String require(String value, String name) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Missing claim: " + name);
    }
    return value;
  }

  private static String firstNonNull(String... values) {
    for (String v : values) {
      if (v != null && !v.isBlank()) return v;
    }
    return null;
  }

  /** Dev SSO configuration; bound to {@code codepilot.security.sso.dev}. */
  @Validated
  @ConfigurationProperties(prefix = "codepilot.security.sso.dev")
  public record DevSsoProperties(
      boolean enabled,
      @NotBlank @Size(min = 32) String secret,
      Duration tokenTtl) {
    public DevSsoProperties {
      if (tokenTtl == null) {
        tokenTtl = Duration.ofHours(1);
      }
    }
  }

  @Configuration
  @ConditionalOnProperty(prefix = "codepilot.security.sso.dev", name = "enabled", havingValue = "true")
  static class Registrar {
    // Triggers ConfigurationProperties binding when dev SSO is enabled.
  }
}