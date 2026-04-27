package io.codepilot.api.auth;

import io.codepilot.common.config.SecurityProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Auto-configuration for {@link SsoVerifier}. Selects the appropriate implementation based on
 * configuration properties:
 *
 * <ol>
 *   <li><b>OIDC (recommended for production)</b>: Activated when {@code
 *       codepilot.security.sso.oidc.issuer-uri} is set. Uses {@link OidcSsoVerifier} with JWKs
 *       validation.
 *   <li><b>Enterprise SSO Bridge (existing)</b>: Activated when {@code
 *       codepilot.security.sso.secret} is set. Uses {@link HmacSsoVerifier} with shared HMAC
 *       secret.
 *   <li><b>Dev (non-production only)</b>: Activated when {@code
 *       codepilot.security.sso.dev.enabled=true}. Uses {@link DevSsoVerifier} for local
 *       development.
 * </ol>
 *
 * <p>Priority: OIDC > Dev > HMAC. If multiple are configured, OIDC takes precedence. Dev is
 * mutually exclusive with OIDC in practice (you wouldn't configure both). If none is configured,
 * the application fails to start (no SsoVerifier bean).
 */
@AutoConfiguration
@EnableConfigurationProperties({
  OidcProperties.class,
  DevSsoVerifier.DevSsoProperties.class,
  HmacSsoVerifier.SsoProperties.class
})
public class SsoVerifierAutoConfiguration {

  private static final Logger log = LoggerFactory.getLogger(SsoVerifierAutoConfiguration.class);

  /**
   * Composite SsoVerifier that delegates to the first available implementation. This bean is only
   * created when no other SsoVerifier bean exists (i.e., when the @ConditionalOnProperty beans
   * didn't activate).
   *
   * <p>In practice, one of the conditional implementations (OidcSsoVerifier, HmacSsoVerifier, or
   * DevSsoVerifier) will be the active bean. This fallback exists to provide a clear error message
   * if none is configured.
   */
  @Bean
  @ConditionalOnMissingBean(SsoVerifier.class)
  public SsoVerifier noOpSsoVerifier() {
    log.error(
        "No SsoVerifier implementation is configured! "
            + "Please set one of: codepilot.security.sso.oidc.issuer-uri (OIDC), "
            + "codepilot.security.sso.secret (HMAC bridge), or "
            + "codepilot.security.sso.dev.enabled=true (dev only)");
    return ssoToken ->
        reactor.core.publisher.Mono.error(
            new IllegalArgumentException(
                "No SSO verifier configured. "
                    + "Set codepilot.security.sso.oidc.issuer-uri, "
                    + "codepilot.security.sso.secret, or "
                    + "codepilot.security.sso.dev.enabled=true"));
  }
}