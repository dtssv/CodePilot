package io.codepilot.api.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.text.ParseException;
import java.util.Date;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Corporate SSO bridge implementation: a deployment-side adapter signs a "bootstrap token"
 * (HS256, ≤5 min lifetime) with the shared {@code codepilot.security.sso.hmac-bridge.secret}.
 *
 * <p>This is intentionally simple — most production deployments should prefer
 * {@link OidcSsoVerifier}.
 */
@Service
@ConditionalOnProperty(prefix = "codepilot.security.sso.hmac-bridge", name = "secret")
public class HmacSsoVerifier implements SsoVerifier {

  private final JWSVerifier verifier;

  public HmacSsoVerifier(SsoProperties props) throws JOSEException {
    if (props.hmacBridge() == null) {
      throw new IllegalStateException("HmacSsoVerifier instantiated without hmacBridge config");
    }
    this.verifier = new MACVerifier(props.hmacBridge().secret().getBytes());
  }

  @Override
  public Mono<VerifiedIdentity> verify(String ssoToken) {
    return Mono.fromCallable(
        () -> {
          SignedJWT jwt = parseOrThrow(ssoToken);
          if (!verifyOrThrow(jwt)) {
            throw new IllegalArgumentException("Invalid SSO signature");
          }
          JWTClaimsSet claims = readClaimsOrThrow(jwt);
          if (claims.getExpirationTime() == null
              || claims.getExpirationTime().before(new Date())) {
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

  private static SignedJWT parseOrThrow(String token) {
    try {
      return SignedJWT.parse(token);
    } catch (ParseException e) {
      throw new IllegalArgumentException("Malformed SSO token");
    }
  }

  private boolean verifyOrThrow(SignedJWT jwt) {
    try {
      return jwt.verify(verifier);
    } catch (JOSEException e) {
      throw new IllegalArgumentException("SSO verification failed");
    }
  }

  private static JWTClaimsSet readClaimsOrThrow(SignedJWT jwt) {
    try {
      return jwt.getJWTClaimsSet();
    } catch (ParseException e) {
      throw new IllegalArgumentException("Malformed SSO claims");
    }
  }

  private static String require(String value, String name) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Missing claim: " + name);
    }
    return value;
  }
}