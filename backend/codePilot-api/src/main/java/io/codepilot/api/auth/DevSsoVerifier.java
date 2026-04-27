package io.codepilot.api.auth;

import jakarta.annotation.PostConstruct;
import java.security.MessageDigest;
import java.util.Base64;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Local-only SSO verifier for developer convenience.
 *
 * <p>Active <strong>only</strong> when:
 *
 * <ul>
 *   <li>the active Spring profile contains {@code dev}; and
 *   <li>{@code codepilot.security.sso.dev.enabled=true}; and
 *   <li>a non-trivial {@code codepilot.security.sso.dev.token} is configured.
 * </ul>
 *
 * <p>Plugin login flow:
 * {@code POST /v1/auth/login} with body {@code {"ssoToken":"<dev-token>:<userId>:<tenant>:<device>"}}.
 * The shared secret prevents accidental access while still avoiding any external dependency for
 * unit / integration tests and demos.
 */
@Service
@Profile("dev")
@ConditionalOnProperty(prefix = "codepilot.security.sso.dev", name = "enabled", havingValue = "true")
public class DevSsoVerifier implements SsoVerifier {

  private static final Logger log = LoggerFactory.getLogger(DevSsoVerifier.class);

  private final byte[] tokenBytes;

  public DevSsoVerifier(SsoProperties props) {
    if (props.dev() == null || props.dev().token() == null) {
      throw new IllegalStateException("DevSsoVerifier requires sso.dev.token");
    }
    this.tokenBytes = props.dev().token().getBytes();
  }

  @PostConstruct
  void warn() {
    log.warn(
        "DevSsoVerifier is ENABLED. Do NOT use this in production. Token fingerprint: {}",
        fingerprint(tokenBytes));
  }

  @Override
  public Mono<VerifiedIdentity> verify(String ssoToken) {
    return Mono.fromCallable(
        () -> {
          if (ssoToken == null || ssoToken.isBlank()) {
            throw new IllegalArgumentException("Missing dev SSO token");
          }
          int firstColon = ssoToken.indexOf(':');
          if (firstColon < 0) {
            throw new IllegalArgumentException("Bad dev SSO token format");
          }
          String prefix = ssoToken.substring(0, firstColon);
          if (!MessageDigest.isEqual(prefix.getBytes(), tokenBytes)) {
            throw new IllegalArgumentException("Invalid dev SSO token");
          }
          String[] parts = ssoToken.substring(firstColon + 1).split(":", 3);
          if (parts.length != 3) {
            throw new IllegalArgumentException("Bad dev SSO token payload");
          }
          String userId = parts[0];
          String tenant = parts[1];
          String device = parts[2];
          return new VerifiedIdentity(
              tenant, userId, "dev:" + userId, userId + "@dev.local", device);
        });
  }

  private static String fingerprint(byte[] bytes) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      byte[] digest = md.digest(bytes);
      return "sha256:" + Base64.getEncoder().withoutPadding().encodeToString(digest).substring(0, 12);
    } catch (Exception e) {
      return "unknown";
    }
  }
}