package io.codepilot.api.auth;

import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.JWSVerifierResolver;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.proc.JWKSecurityContext;
import com.nimbusds.jose.proc.JWSVerifierFactory;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import com.nimbusds.jwt.proc.JWTProcessor;
import java.text.ParseException;
import java.util.Date;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * OIDC-native {@link SsoVerifier}. Validates an upstream IdP's id_token against JWKs, checks
 * {@code iss}, {@code aud}, {@code exp}, and extracts user identity claims.
 *
 * <p>Activated when {@code codepilot.security.sso.oidc.issuer-uri} is set.
 *
 * <h3>Claim mapping:</h3>
 *
 * <ul>
 *   <li>{@code sub} → subject (required)
 *   <li>{@code tid} or custom claim → tenantId (defaults to "default")
 *   <li>{@code did} → deviceId (defaults to "unknown")
 *   <li>{@code name} / {@code preferred_username} → displayName
 *   <li>{@code email} → email
 * </ul>
 */
@Service
@ConditionalOnProperty(prefix = "codepilot.security.sso.oidc", name = "issuer-uri")
public class OidcSsoVerifier implements SsoVerifier {

  private static final Logger log = LoggerFactory.getLogger(OidcSsoVerifier.class);

  private final OidcProperties props;
  private final JwksCacheService jwksCache;

  public OidcSsoVerifier(OidcProperties props, JwksCacheService jwksCache) {
    this.props = props;
    this.jwksCache = jwksCache;
  }

  @Override
  public Mono<VerifiedIdentity> verify(String ssoToken) {
    return jwksCache
        .getJwkSource()
        .flatMap(
            jwkSource ->
                Mono.fromCallable(
                        () -> {
                          SignedJWT jwt;
                          try {
                            jwt = SignedJWT.parse(ssoToken);
                          } catch (ParseException e) {
                            throw new IllegalArgumentException("Malformed OIDC id_token");
                          }

                          // Verify signature using JWK source
                          verifySignature(jwt, jwkSource);

                          JWTClaimsSet claims;
                          try {
                            claims = jwt.getJWTClaimsSet();
                          } catch (ParseException e) {
                            throw new IllegalArgumentException("Malformed OIDC claims");
                          }

                          // Validate standard OIDC claims
                          validateClaims(claims);

                          return mapIdentity(claims);
                        })
                    .onErrorMap(
                        IllegalStateException.class,
                        ex -> new IllegalArgumentException(ex.getMessage())));
  }

  private void verifySignature(SignedJWT jwt, com.nimbusds.jose.jwk.source.JWKSource<JWKSecurityContext> jwkSource) {
    try {
      DefaultJWTProcessor<JWKSecurityContext> processor = new DefaultJWTProcessor<>();
      processor.setJWKSSource(jwkSource);
      // We only verify signature here; claim validation is done separately below
      processor.process(jwt, null);
    } catch (Exception e) {
      log.debug("OIDC id_token signature verification failed: {}", e.getMessage());
      throw new IllegalArgumentException("Invalid OIDC id_token signature");
    }
  }

  private void validateClaims(JWTClaimsSet claims) {
    // iss — must match accepted issuers
    String issuer = claims.getIssuer();
    if (issuer == null || !props.acceptedIssuers().contains(issuer)) {
      throw new IllegalArgumentException(
          "Invalid issuer: " + issuer + ", expected one of: " + props.acceptedIssuers());
    }

    // aud — must contain our clientId
    List<String> audiences = claims.getAudience();
    if (audiences == null || audiences.stream().noneMatch(props.clientId()::equals)) {
      throw new IllegalArgumentException(
          "Invalid audience: " + audiences + ", expected: " + props.clientId());
    }

    // exp — must not be expired
    Date expiry = claims.getExpirationTime();
    if (expiry == null || expiry.before(new Date())) {
      throw new IllegalArgumentException("OIDC id_token expired");
    }
  }

  private VerifiedIdentity mapIdentity(JWTClaimsSet claims) {
    String subject = requireClaim(claims.getSubject(), "sub");
    // Tenant: prefer "tid" claim, fall back to "default"
    String tenant = firstNonNull((String) claims.getClaim("tid"), "default");
    // Device: prefer "did" claim, fall back to "unknown"
    String device = firstNonNull((String) claims.getClaim("did"), "unknown");
    String displayName =
        firstNonNull(
            claims.getStringClaim("name"),
            claims.getStringClaim("preferred_username"),
            subject);
    String email = claims.getStringClaim("email");

    return new VerifiedIdentity(tenant, subject, displayName, email, device);
  }

  private static String requireClaim(String value, String name) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Missing required claim: " + name);
    }
    return value;
  }

  @SafeVarargs
  private static String firstNonNull(String... values) {
    for (String v : values) {
      if (v != null && !v.isBlank()) return v;
    }
    return null;
  }

  @Configuration
  @ConditionalOnProperty(prefix = "codepilot.security.sso.oidc", name = "issuer-uri")
  static class Registrar {
    // Ensures ConfigurationProperties is auto-bound when OIDC is enabled.
  }
}