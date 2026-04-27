package io.codepilot.api.auth;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.proc.JWSKeySelector;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.jwk.source.RemoteJWKSet;
import com.nimbusds.jose.jwk.source.URLBasedJWKSetSource;
import com.nimbusds.jose.util.DefaultResourceRetriever;
import java.net.MalformedURLException;
import java.net.URL;
import java.text.ParseException;
import java.util.Date;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * OIDC verifier suitable for production. Downloads & caches the IdP JWKs and validates the
 * incoming id-token signature, issuer, audience, and expiry. Bound users / tenants / device ids
 * follow CodePilot conventions:
 *
 * <ul>
 *   <li>{@code sub} → user subject (mandatory)
 *   <li>{@code tid} → tenant id (mandatory; deployment-side claim)
 *   <li>{@code did} → device id (mandatory; provided by the plugin via the device-flow scope)
 *   <li>{@code email} / {@code name} → optional metadata
 * </ul>
 *
 * <p>If your IdP doesn't natively emit {@code tid} / {@code did}, configure a claim mapper on
 * the IdP side (most providers support custom claims).
 */
@Service
@ConditionalOnProperty(prefix = "codepilot.security.sso.oidc", name = "issuer")
public class OidcSsoVerifier implements SsoVerifier {

  private final ConfigurableJWTProcessor<SecurityContext> processor;
  private final List<String> audiences;
  private final String issuer;

  public OidcSsoVerifier(SsoProperties props) {
    if (props.oidc() == null) {
      throw new IllegalStateException("OidcSsoVerifier requires sso.oidc.* configuration");
    }
    SsoProperties.Oidc cfg = props.oidc();
    this.issuer = cfg.issuer();
    this.audiences = cfg.audiences() == null ? List.of() : List.copyOf(cfg.audiences());

    URL jwksUrl;
    try {
      jwksUrl = cfg.jwksUri().toURL();
    } catch (MalformedURLException e) {
      throw new IllegalStateException("Invalid jwks-uri", e);
    }
    DefaultResourceRetriever retriever =
        new DefaultResourceRetriever(2_000, 2_000, 50_000);

    JWKSource<SecurityContext> jwkSource =
        JWKSourceBuilder.create(new URLBasedJWKSetSource<>(jwksUrl, retriever))
            .cache(cfg.jwksCacheTtl().toMillis(), 30_000)
            .retrying(true)
            .rateLimited(false)
            .build();

    JWSKeySelector<SecurityContext> keySelector =
        new JWSVerificationKeySelector<>(
            List.of(JWSAlgorithm.RS256, JWSAlgorithm.ES256, JWSAlgorithm.RS384, JWSAlgorithm.RS512),
            jwkSource);

    DefaultJWTProcessor<SecurityContext> proc = new DefaultJWTProcessor<>();
    proc.setJWSKeySelector(keySelector);
    this.processor = proc;
  }

  @Override
  public Mono<VerifiedIdentity> verify(String idToken) {
    return Mono.fromCallable(
            () -> {
              SignedJWT jwt;
              try {
                jwt = SignedJWT.parse(idToken);
              } catch (ParseException e) {
                throw new IllegalArgumentException("Malformed id-token");
              }
              JWTClaimsSet claims;
              try {
                claims = processor.process(jwt, null);
              } catch (Exception e) {
                throw new IllegalArgumentException("id-token rejected: " + e.getMessage());
              }
              if (!issuer.equals(claims.getIssuer())) {
                throw new IllegalArgumentException("Bad issuer");
              }
              if (!audiences.isEmpty()
                  && (claims.getAudience() == null
                      || claims.getAudience().stream().noneMatch(audiences::contains))) {
                throw new IllegalArgumentException("Bad audience");
              }
              Date exp = claims.getExpirationTime();
              if (exp == null || exp.before(new Date())) {
                throw new IllegalArgumentException("id-token expired");
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
            })
        // The Nimbus call may do blocking I/O on a JWKs cache miss.
        .subscribeOn(Schedulers.boundedElastic());
  }

  private static String require(String value, String name) {
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Missing claim: " + name);
    }
    return value;
  }
}