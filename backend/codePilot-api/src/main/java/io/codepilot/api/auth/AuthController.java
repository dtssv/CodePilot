package io.codepilot.api.auth;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.gateway.security.JwtService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.Set;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * Issues / refreshes CodePilot access tokens and proxies the OIDC Device Code Flow.
 *
 * <p>The login flow exchanges an upstream SSO token (verified via {@link SsoVerifier}) for a pair
 * of (access, refresh) JWTs and a one-time {@code deviceSecret} used for HMAC signing.
 *
 * <p>When OIDC is configured, the Device Code Flow endpoints allow the plugin to initiate user
 * login without holding IdP credentials directly. These endpoints return 404 when OIDC is not
 * configured.
 */
@RestController
@RequestMapping(
    value = "/v1/auth",
    produces = MediaType.APPLICATION_JSON_VALUE,
    consumes = MediaType.APPLICATION_JSON_VALUE)
public class AuthController {

  private static final SecureRandom RANDOM = new SecureRandom();

  private final SsoVerifier ssoVerifier;
  private final JwtService jwt;
  private final DeviceCodeFlowService deviceCodeFlow;

  public AuthController(SsoVerifier ssoVerifier, JwtService jwt) {
    this(ssoVerifier, jwt, null);
  }

  public AuthController(
      SsoVerifier ssoVerifier, JwtService jwt, DeviceCodeFlowService deviceCodeFlow) {
    this.ssoVerifier = ssoVerifier;
    this.jwt = jwt;
    this.deviceCodeFlow = deviceCodeFlow;
  }

  // ---- Login / Refresh ----

  @PostMapping("/login")
  public Mono<ApiResponse<LoginResponse>> login(@RequestBody @Valid LoginRequest req) {
    return ssoVerifier
        .verify(req.ssoToken())
        .onErrorMap(
            IllegalArgumentException.class,
            ex -> new CodePilotException(ErrorCodes.UNAUTHORIZED, ex.getMessage()))
        .map(
            id -> {
              JwtService.Issued access =
                  jwt.issueAccess(id.subject(), id.tenantId(), id.deviceId(), Set.of("user"));
              JwtService.Issued refresh =
                  jwt.issueRefresh(id.subject(), id.tenantId(), id.deviceId());
              String deviceSecret = newDeviceSecret();
              return ApiResponse.ok(
                  new LoginResponse(
                      access.token(),
                      access.expiresAt(),
                      refresh.token(),
                      refresh.expiresAt(),
                      deviceSecret));
            });
  }

  @PostMapping("/refresh")
  public Mono<ApiResponse<RefreshResponse>> refresh(@RequestBody @Valid RefreshRequest req) {
    return Mono.fromCallable(
            () -> {
              var principal = jwt.verify(req.refreshToken());
              if (!principal.scopes().contains("refresh")) {
                throw new CodePilotException(ErrorCodes.UNAUTHORIZED, "Not a refresh token");
              }
              JwtService.Issued access =
                  jwt.issueAccess(
                      principal.userId(),
                      principal.tenantId(),
                      principal.deviceId(),
                      Set.of("user"));
              return ApiResponse.ok(new RefreshResponse(access.token(), access.expiresAt()));
            })
        .onErrorMap(
            IllegalArgumentException.class,
            ex -> new CodePilotException(ErrorCodes.UNAUTHORIZED, "Invalid refresh token"));
  }

  // ---- Device Code Flow (OIDC proxy) ----

  /**
   * Step 1 of RFC 8628: request a device code from the IdP. The plugin calls this to initiate the
   * login flow; it then shows the user_code + verification_uri to the user.
   *
   * <p>Returns 404 when OIDC is not configured.
   */
  @PostMapping("/device-code")
  public Mono<ApiResponse<DeviceCodeFlowService.DeviceCodeResponse>> deviceCode() {
    if (deviceCodeFlow == null) {
      return Mono.error(
          new CodePilotException(ErrorCodes.NOT_FOUND, "Device Code Flow not available (OIDC not configured)"));
    }
    return deviceCodeFlow
        .requestDeviceCode()
        .map(ApiResponse::ok)
        .onErrorMap(
            Exception.class,
            ex -> new CodePilotException(ErrorCodes.INTERNAL, "Failed to request device code"));
  }

  /**
   * Step 3 of RFC 8628: poll the IdP for the token result. The plugin calls this at the
   * suggested interval until it gets {@code status=authorized} (with an id_token) or
   * {@code status=expired}.
   *
   * <p>Returns 404 when OIDC is not configured.
   */
  @PostMapping("/device-token")
  public Mono<ApiResponse<DeviceCodeFlowService.DeviceTokenResponse>> deviceToken(
      @RequestBody @Valid DeviceTokenRequest req) {
    if (deviceCodeFlow == null) {
      return Mono.error(
          new CodePilotException(ErrorCodes.NOT_FOUND, "Device Code Flow not available (OIDC not configured)"));
    }
    return deviceCodeFlow
        .pollDeviceToken(req.deviceCodeKey())
        .map(ApiResponse::ok)
        .onErrorMap(
            IllegalArgumentException.class,
            ex -> new CodePilotException(ErrorCodes.BAD_REQUEST, ex.getMessage()));
  }

  /** 32 bytes of CSPRNG output, base64url, no padding. */
  private static String newDeviceSecret() {
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  // -------------------------- DTOs --------------------------

  public record LoginRequest(@NotBlank String ssoToken) {}

  public record LoginResponse(
      String accessToken,
      Instant accessExpiresAt,
      String refreshToken,
      Instant refreshExpiresAt,
      String deviceSecret) {}

  public record RefreshRequest(@NotBlank String refreshToken) {}

  public record RefreshResponse(String accessToken, Instant accessExpiresAt) {}

  public record DeviceTokenRequest(@NotBlank String deviceCodeKey) {}
}