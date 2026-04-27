package io.codepilot.api.auth;

import reactor.core.publisher.Mono;

/**
 * Pluggable SSO token verifier. Implementations validate the upstream identity provider's token
 * (OIDC id-token, corporate SSO, etc.) and translate it into a {@link VerifiedIdentity}.
 *
 * <p>This interface is intentionally tiny so deployments can swap in their own implementation
 * (Keycloak, Auth0, internal SSO, …) without touching the auth controller.
 */
public interface SsoVerifier {

  Mono<VerifiedIdentity> verify(String ssoToken);

  record VerifiedIdentity(
      String tenantId, String subject, String displayName, String email, String deviceId) {}
}