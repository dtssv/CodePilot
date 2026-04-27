package io.codepilot.api.auth;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/**
 * Implements the server-side of RFC 8628 Device Authorization Flow.
 *
 * <p>The plugin does NOT hold IdP credentials. Instead it calls our proxy endpoints:
 *
 * <ol>
 *   <li>{@code POST /v1/auth/device-code} → we ask the IdP for a device_code + user_code + verification_uri
 *   <li>Plugin shows the user_code + URI; user opens browser, enters code, authorizes
 *   <li>{@code POST /v1/auth/device-token} → we poll the IdP's token endpoint; on success return the id_token
 * </ol>
 *
 * <p>We store the IdP-returned {@code device_code} in Redis (short TTL) keyed by our own
 * {@code deviceCodeKey}, so the token-poll step can look it up.
 */
public class DeviceCodeFlowService {

  private static final Logger log = LoggerFactory.getLogger(DeviceCodeFlowService.class);
  private static final String REDIS_KEY_PREFIX = "auth:device-code:";
  private static final Duration DEVICE_CODE_TTL = Duration.ofMinutes(15);

  private final OidcProperties oidcProps;
  private final WebClient webClient;
  private final ReactiveStringRedisTemplate redis;

  public DeviceCodeFlowService(
      OidcProperties oidcProps, ReactiveStringRedisTemplate redis) {
    this.oidcProps = oidcProps;
    this.redis = redis;
    this.webClient = WebClient.builder().build();
  }

  /**
   * Step 1: Request a device code from the IdP. Returns the device_code, user_code,
   * verification_uri, etc. to the plugin.
   */
  public Mono<DeviceCodeResponse> requestDeviceCode() {
    String endpoint = resolveDeviceAuthorizationEndpoint();
    return webClient
        .post()
        .uri(URI.create(endpoint))
        .bodyValue(
            Map.of(
                "client_id", oidcProps.clientId(),
                "scope", "openid profile email"))
        .retrieve()
        .bodyToMono(IdpDeviceCodeResponse.class)
        .flatMap(
            idpResp -> {
              // Store the IdP device_code in Redis for later token polling
              String ourKey = UUID.randomUUID().toString();
              String redisKey = REDIS_KEY_PREFIX + ourKey;
              String value =
                  idpResp.deviceCode()
                      + "|"
                      + (idpResp.interval() != null ? idpResp.interval() : 5);
              return redis
                  .opsForValue()
                  .set(redisKey, value, DEVICE_CODE_TTL)
                  .thenReturn(
                      new DeviceCodeResponse(
                          ourKey,
                          idpResp.userCode(),
                          idpResp.verificationUri(),
                          idpResp.verificationUriComplete(),
                          idpResp.expiresIn() != null ? idpResp.expiresIn() : 900,
                          idpResp.interval() != null ? idpResp.interval() : 5));
            });
  }

  /**
   * Step 2: Poll the IdP token endpoint with the stored device_code. Returns:
   * - On success: the id_token (which the plugin then sends to /v1/auth/login)
   * - On pending: a "authorization_pending" indicator
   * - On slow_down: an increased interval hint
   */
  public Mono<DeviceTokenResponse> pollDeviceToken(String deviceCodeKey) {
    String redisKey = REDIS_KEY_PREFIX + deviceCodeKey;
    return redis
        .opsForValue()
        .get(redisKey)
        .switchIfEmpty(Mono.error(new IllegalArgumentException("Device code expired or not found")))
        .flatMap(
            storedValue -> {
              String[] parts = storedValue.split("\\|", 2);
              String idpDeviceCode = parts[0];
              int interval = parts.length > 1 ? Integer.parseInt(parts[1]) : 5;

              String tokenEndpoint = resolveTokenEndpoint();
              Map<String, String> body =
                  Map.of(
                      "grant_type", "urn:ietf:params:oauth:grant-type:device_code",
                      "client_id", oidcProps.clientId(),
                      "device_code", idpDeviceCode);

              WebClient.RequestBodySpec request =
                  webClient.post().uri(URI.create(tokenEndpoint));

              // Add client_secret if configured (confidential client)
              if (oidcProps.clientSecret() != null && !oidcProps.clientSecret().isBlank()) {
                body = new java.util.HashMap<>(body);
                body.put("client_secret", oidcProps.clientSecret());
              }

              return request
                  .bodyValue(body)
                  .retrieve()
                  .bodyToMono(String.class)
                  .map(
                      resp -> {
                        // IdP returns id_token on success
                        if (resp.contains("\"id_token\"")) {
                          // Parse id_token from JSON response
                          try {
                            com.fasterxml.jackson.databind.ObjectMapper mapper =
                                new com.fasterxml.jackson.databind.ObjectMapper();
                            var node = mapper.readTree(resp);
                            String idToken = node.get("id_token").asText();
                            // Clean up Redis key
                            redis.delete(redisKey).subscribe();
                            return new DeviceTokenResponse(
                                "authorized", idToken, null, null);
                          } catch (Exception e) {
                            log.warn("Failed to parse IdP token response", e);
                            return new DeviceTokenResponse(
                                "error", null, "token_parse_error", null);
                          }
                        }
                        // Check for pending / slow_down
                        if (resp.contains("authorization_pending")) {
                          return new DeviceTokenResponse(
                              "pending", null, null, null);
                        }
                        if (resp.contains("slow_down")) {
                          return new DeviceTokenResponse(
                              "pending", null, null, interval + 5);
                        }
                        if (resp.contains("expired_token")) {
                          redis.delete(redisKey).subscribe();
                          return new DeviceTokenResponse(
                              "expired", null, "device_code_expired", null);
                        }
                        return new DeviceTokenResponse(
                            "error", null, "unknown_error", null);
                      });
            });
  }

  private String resolveDeviceAuthorizationEndpoint() {
    if (oidcProps.deviceAuthorizationEndpoint() != null
        && !oidcProps.deviceAuthorizationEndpoint().isBlank()) {
      return oidcProps.deviceAuthorizationEndpoint();
    }
    // Derive from issuer (common convention for Keycloak)
    String issuer =
        oidcProps.issuerUri().endsWith("/")
            ? oidcProps.issuerUri()
            : oidcProps.issuerUri() + "/";
    return issuer + "protocol/openid-connect/auth/device";
  }

  private String resolveTokenEndpoint() {
    if (oidcProps.tokenEndpoint() != null && !oidcProps.tokenEndpoint().isBlank()) {
      return oidcProps.tokenEndpoint();
    }
    String issuer =
        oidcProps.issuerUri().endsWith("/")
            ? oidcProps.issuerUri()
            : oidcProps.issuerUri() + "/";
    return issuer + "protocol/openid-connect/token";
  }

  // ---- DTOs ----

  /** Our API response for device-code request. */
  public record DeviceCodeResponse(
      String deviceCodeKey,
      String userCode,
      String verificationUri,
      String verificationUriComplete,
      int expiresIn,
      int interval) {}

  /** Our API response for device-token poll. */
  public record DeviceTokenResponse(
      String status, // authorized | pending | expired | error
      String idToken, // only when status=authorized
      String errorCode, // only when status=error or expired
      Integer interval) {} // suggested poll interval (only when slow_down)

  /** IdP's device-code response (RFC 8628 §3.1). */
  record IdpDeviceCodeResponse(
      String deviceCode,
      String userCode,
      String verificationUri,
      String verificationUriComplete,
      Integer expiresIn,
      Integer interval) {}
}