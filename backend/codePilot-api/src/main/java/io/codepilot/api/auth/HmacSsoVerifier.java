package io.codepilot.api.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.text.ParseException;
import java.util.Date;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;
import org.springframework.validation.annotation.Validated;
import reactor.core.publisher.Mono;

/**
 * Default {@link SsoVerifier} implementation: the upstream SSO Adapter (e.g. corporate IDP) signs
 * a bootstrap token with a shared HMAC secret. Claims:
 *
 * <ul>
 *   <li>{@code sub}     — user subject (required)
 *   <li>{@code tid}     — tenant id (required)
 *   <li>{@code did}     — device id (required)
 *   <li>{@code name}    — display name
 *   <li>{@code email}   — user email
 *   <li>{@code exp}     — expiry (required, < 5min)
 * </ul>
 *
 * <p>Deployments that integrate with OIDC directly should provide their own bean to override.
 */
@Service
@ConditionalOnProperty(prefix = "codepilot.security.sso", name = "secret")
public class HmacSsoVerifier implements SsoVerifier {

  private final JWSVerifier verifier;

  public HmacSsoVerifier(SsoProperties props) throws JOSEException {
    this.verifier = new MACVerifier(props.secret().getBytes());
  }

  @Override
  public Mono<VerifiedIdentity> verify(String ssoToken) {
    return Mono.fromCallable(
        () -> {
          SignedJWT jwt;
          try {
            jwt = SignedJWT.parse(ssoToken);
          } catch (ParseException e) {
            throw new IllegalArgumentException("Malformed SSO token");
          }
          try {
            if (!jwt.verify(verifier)) {
              throw new IllegalArgumentException("Invalid SSO signature");
            }
          } catch (JOSEException e) {
            throw new IllegalArgumentException("SSO verification failed");
          }
          JWTClaimsSet claims;
          try {
            claims = jwt.getJWTClaimsSet();
          } catch (ParseException e) {
            throw new IllegalArgumentException("Malformed SSO claims");
          }
          if (claims.getExpirationTime() == null || claims.getExpirationTime().before(new Date())) {
            throw new IllegalArgumentException("SSO token expired");
          }
          String subject = require(claims.getSubject(), "sub");
          String tenant = require((String) claims.getClaim("tid"), "tid");
          String device = require((String) claims.getClaim("did"), "did");
          return new VerifiedIdentity(
              tenant,
              subject,
              (String) claims.getClaim("name"),
              (String) claims.getClaim("email"),
              device);
        });
  }

  private static String require(String value, String name) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Missing claim: " + name);
    }
    return value;
  }

  /** SSO bridge configuration; bound to {@code codepilot.security.sso}. */
  @Validated
  @ConfigurationProperties(prefix = "codepilot.security.sso")
  public record SsoProperties(@NotBlank @Size(min = 32) String secret) {}

  @Configuration
  @ConditionalOnProperty(prefix = "codepilot.security.sso", name = "secret")
  static class Registrar {
    // ConfigurationProperties is auto-bound; this nested class only triggers the conditional.
  }
}