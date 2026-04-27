package io.codepilot.api.auth;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.JWKSecurityContext;
import com.nimbusds.jose.proc.JWKSecurityContextResolver;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Reactive JWK Set cache. Pulls the IdP's {@code jwks_uri} on first use and refreshes after
 * {@link OidcProperties#jwksCacheTtl()}.
 *
 * <p>Uses a simple volatile reference + timestamp; no external cache needed since JWK sets are
 * small (~few KB) and the refresh rate is low (5 min default).
 */
public class JwksCacheService {

  private static final Logger log = LoggerFactory.getLogger(JwksCacheService.class);

  private final WebClient webClient;
  private final OidcProperties props;

  private final AtomicReference<CachedJwkSet> cache = new AtomicReference<>();

  public JwksCacheService(OidcProperties props) {
    this.props = props;
    this.webClient = WebClient.builder().build();
  }

  /**
   * Returns the cached JWK set, fetching (or re-fetching) if expired. The result is memoized on
   * the first successful call.
   */
  public Mono<JWKSource<JWKSecurityContext>> getJwkSource() {
    CachedJwkSet current = cache.get();
    if (current != null && !current.isExpired(props.jwksCacheTtl())) {
      return Mono.just(current.source());
    }
    return fetchJwks().map(this::updateCache).map(CachedJwkSet::source);
  }

  /**
   * Derives the well-known OIDC discovery URL from issuerUri if jwksUri is not explicitly
   * configured.
   */
  public String resolveJwksUri() {
    if (props.jwksUri() != null && !props.jwksUri().isBlank()) {
      return props.jwksUri();
    }
    // Standard OIDC discovery: {issuerUri}/.well-known/openid-configuration
    // For simplicity we directly construct the jwks_uri convention for common IdPs:
    // Keycloak: {issuerUri}/protocol/openid-connect/certs
    // Most others: discover from .well-known
    String issuer = props.issuerUri().endsWith("/") ? props.issuerUri() : props.issuerUri() + "/";
    return issuer + ".well-known/openid-configuration";
  }

  private Mono<JWKSource<JWKSecurityContext>> fetchJwks() {
    String jwksUri = props.jwksUri();
    if (jwksUri == null || jwksUri.isBlank()) {
      // Need to discover from .well-known first
      return discoverAndFetchJwks();
    }
    return fetchJwkSet(jwksUri);
  }

  private Mono<JWKSource<JWKSecurityContext>> discoverAndFetchJwks() {
    String issuer = props.issuerUri().endsWith("/") ? props.issuerUri() : props.issuerUri() + "/";
    String discoveryUrl = issuer + ".well-known/openid-configuration";
    return webClient
        .get()
        .uri(URI.create(discoveryUrl))
        .retrieve()
        .bodyToMono(OidcDiscoveryDocument.class)
        .flatMap(
            doc -> {
              if (doc.jwksUri() == null || doc.jwksUri().isBlank()) {
                return Mono.error(
                    new IllegalStateException(
                        "OIDC discovery at " + discoveryUrl + " did not return jwks_uri"));
              }
              return fetchJwkSet(doc.jwksUri());
            })
        .switchIfEmpty(
            Mono.error(
                new IllegalStateException("Empty response from OIDC discovery: " + discoveryUrl)));
  }

  private Mono<JWKSource<JWKSecurityContext>> fetchJwkSet(String uri) {
    log.debug("Fetching JWK set from {}", uri);
    return webClient
        .get()
        .uri(URI.create(uri))
        .retrieve()
        .bodyToMono(String.class)
        .publishOn(Schedulers.boundedElastic())
        .map(
            body -> {
              try {
                var jwkSet = JWKSet.parse(body);
                return new ImmutableJWKSet<JWKSecurityContext>(jwkSet);
              } catch (Exception e) {
                throw new IllegalStateException("Failed to parse JWK set from " + uri, e);
              }
            });
  }

  private CachedJwkSet updateCache(JWKSource<JWKSecurityContext> source) {
    CachedJwkSet entry = new CachedJwkSet(source, Instant.now());
    cache.set(entry);
    return entry;
  }

  private record CachedJwkSet(JWKSource<JWKSecurityContext> source, Instant fetchedAt) {
    boolean isExpired(Duration ttl) {
      return fetchedAt.plus(ttl).isBefore(Instant.now());
    }
  }

  /** Minimal OIDC discovery document — we only need jwks_uri. */
  record OidcDiscoveryDocument(String jwksUri) {}
}