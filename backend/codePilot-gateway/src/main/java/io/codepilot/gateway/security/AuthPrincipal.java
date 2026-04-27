package io.codepilot.gateway.security;

import java.util.Set;

/**
 * Authenticated request principal injected into the reactor context by {@code JwtAuthWebFilter}.
 * Pure data; no behavior, no side effects.
 */
public record AuthPrincipal(
    String userId, String tenantId, String deviceId, Set<String> scopes, long expiresAtEpochSec) {

  public static final String CTX_KEY = "codepilot.auth";
}