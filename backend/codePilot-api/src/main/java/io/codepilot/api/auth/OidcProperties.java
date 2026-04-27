package io.codepilot.api.auth;

import jakarta.validation.constraints.NotBlank;
import java.time.Duration;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * OIDC SSO configuration. Bound to {@code codepilot.security.sso.oidc}.
 *
 * <p>When {@code codepilot.security.sso.oidc.issuer-uri} is set, the {@link OidcSsoVerifier} is
 * activated and verifies upstream id_tokens against the IdP's JWKs endpoint.
 */
@Validated
@ConfigurationProperties(prefix = "codepilot.security.sso.oidc")
public record OidcProperties(
    /** IdP issuer URI (e.g. {@code https://keycloak.example.com/realms/myrealm}). */
    @NotBlank String issuerUri,
    /** Expected audience — the {@code client_id} registered at the IdP. */
    @NotBlank String clientId,
    /** Client secret for the Device Code Flow token exchange (optional for public clients). */
    String clientSecret,
    /** JWK Set URI — auto-derived from issuerUri if blank (well-known). */
    String jwksUri,
    /** Token endpoint — auto-derived from issuerUri if blank. */
    String tokenEndpoint,
    /** Device authorization endpoint — auto-derived from issuerUri if blank. */
    String deviceAuthorizationEndpoint,
    /** Accepted issuers (defaults to singleton of issuerUri). */
    Set<String> acceptedIssuers,
    /** JWKs cache TTL. */
    Duration jwksCacheTtl) {

  public OidcProperties {
    if (jwksCacheTtl == null) {
      jwksCacheTtl = Duration.ofMinutes(5);
    }
    if (acceptedIssuers == null || acceptedIssuers.isEmpty()) {
      acceptedIssuers = Set.of(issuerUri);
    }
  }
}