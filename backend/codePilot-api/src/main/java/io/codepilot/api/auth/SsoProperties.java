package io.codepilot.api.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Pluggable SSO configuration. Three login methods are supported, in priority order:
 *
 * <ol>
 *   <li>{@code oidc} — recommended for production; verifies an OIDC id-token using IdP JWKs.
 *   <li>{@code hmacBridge} — corporate SSO Adapter signs a CodePilot bootstrap token via shared HMAC.
 *   <li>{@code dev} — local-only; enabled only when {@code codepilot.security.sso.dev.enabled=true}
 *       AND the active Spring profile is {@code dev}. Never enabled by default.
 * </ol>
 *
 * <p>At runtime, {@code AuthController} chooses the configured verifier; if multiple are
 * configured, OIDC wins. The login endpoint accepts the result of <em>whatever</em> the deployment
 * uses — the plugin only ever sends a single {@code ssoToken}.
 */
@Validated
@ConfigurationProperties(prefix = "codepilot.security.sso")
public record SsoProperties(@Valid Oidc oidc, @Valid HmacBridge hmacBridge, @Valid Dev dev) {

  public SsoProperties {
    // Allow nulls; all subsystems are optional.
  }

  /** Standard OpenID Connect provider. */
  public record Oidc(
      @NotBlank String issuer,
      @NotBlank URI jwksUri,
      List<@NotBlank String> audiences,
      Duration jwksCacheTtl,
      DeviceFlow deviceFlow) {

    public Oidc {
      if (jwksCacheTtl == null) jwksCacheTtl = Duration.ofMinutes(15);
    }

    /** RFC 8628 Device Authorization endpoints (delegated by /v1/auth/device-code). */
    public record DeviceFlow(
        @NotBlank URI authorizationEndpoint,
        @NotBlank URI tokenEndpoint,
        @NotBlank String clientId,
        String clientSecret,
        @NotBlank String scope) {}
  }

  /** Corporate SSO bridge using a shared HMAC secret (kept for back-compat). */
  public record HmacBridge(@NotBlank @Size(min = 32) String secret) {}

  /**
   * Local-only convenience. The active Spring profile must literally include {@code dev} for this
   * to take effect; otherwise {@code DevSsoVerifier} silently refuses to authenticate.
   */
  public record Dev(boolean enabled, @Size(min = 16) String token) {}
}