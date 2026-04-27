package io.codepilot.api.auth;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.gateway.security.JwtService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Mono;

/**
 * Auth API.
 *
 * <ul>
 *   <li>{@code POST /v1/auth/login}     — exchange an SSO bootstrap token for CodePilot JWTs.
 *   <li>{@code POST /v1/auth/refresh}   — refresh access token.
 *   <li>{@code GET  /v1/auth/methods}   — describe enabled SSO methods so the plugin can pick.
 *   <li>{@code POST /v1/auth/device-code}  — initiate RFC 8628 Device Authorization at the IdP.
 *   <li>{@code POST /v1/auth/device-token} — poll for an id-token after the user finishes login.
 * </ul>
 */
@RestController
@RequestMapping(
    value = "/v1/auth",
    produces = MediaType.APPLICATION_JSON_VALUE,
    consumes = MediaType.APPLICATION_JSON_VALUE)
public class AuthController {

  private static final SecureRandom RANDOM = new SecureRandom();

  private final List<SsoVerifier> verifiers;
  private final JwtService jwt;
  private final SsoProperties ssoProps;
  private final WebClient http;

  public AuthController(List<SsoVerifier> verifiers, JwtService jwt, SsoProperties ssoProps) {
    this.verifiers = verifiers;
    this.jwt = jwt;
    this.ssoProps = ssoProps;
    this.http = WebClient.builder().build();
  }

  // -------------------- /login & /refresh --------------------

  @PostMapping("/login")
  public Mono<ApiResponse<LoginResponse>> login(@RequestBody @Valid LoginRequest req) {
    return verifyWithFirstAcceptingVerifier(req.ssoToken())
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

  // -------------------- discovery --------------------

  @GetMapping(value = "/methods", consumes = MediaType.ALL_VALUE)
  public Mono<ApiResponse<MethodsResponse>> methods() {
    boolean oidc = ssoProps.oidc() != null;
    boolean hmac = ssoProps.hmacBridge() != null;
    boolean dev =
        ssoProps.dev() != null
            && ssoProps.dev().enabled()
            && ssoProps.dev().token() != null;
    boolean deviceFlow = oidc && ssoProps.oidc().deviceFlow() != null;
    return Mono.just(ApiResponse.ok(new MethodsResponse(oidc, hmac, dev, deviceFlow)));
  }

  // -------------------- device-flow proxy --------------------

  @PostMapping("/device-code")
  public Mono<ApiResponse<DeviceCodeResponse>> deviceCode() {
    SsoProperties.Oidc.DeviceFlow df = requireDeviceFlow();
    Map<String, String> form = new LinkedHashMap<>();
    form.put("client_id", df.clientId());
    form.put("scope", df.scope());
    return http.post()
        .uri(df.authorizationEndpoint())
        .contentType(MediaType.APPLICATION_FORM_URLENCODED)
        .body(BodyInserters.fromFormData(toMultiValueMap(form)))
        .retrieve()
        .bodyToMono(DeviceCodeResponse.class)
        .map(ApiResponse::ok)
        .onErrorMap(
            WebClientResponseException.class,
            ex ->
                new CodePilotException(
                    ErrorCodes.UPSTREAM_MODEL,
                    "Device authorization failed: " + ex.getStatusCode().value()));
  }

  @PostMapping("/device-token")
  public Mono<ApiResponse<DeviceTokenResponse>> deviceToken(
      @RequestBody @Valid DeviceTokenRequest req) {
    SsoProperties.Oidc.DeviceFlow df = requireDeviceFlow();
    Map<String, String> form = new LinkedHashMap<>();
    form.put("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    form.put("client_id", df.clientId());
    form.put("device_code", req.deviceCode());
    if (df.clientSecret() != null) {
      form.put("client_secret", df.clientSecret());
    }
    return http.post()
        .uri(df.tokenEndpoint())
        .contentType(MediaType.APPLICATION_FORM_URLENCODED)
        .body(BodyInserters.fromFormData(toMultiValueMap(form)))
        .retrieve()
        .bodyToMono(DeviceTokenResponse.class)
        .map(ApiResponse::ok)
        .onErrorMap(
            WebClientResponseException.class,
            ex -> {
              // RFC 8628 returns 400 with body {error:"authorization_pending|...|access_denied"}.
              return new CodePilotException(
                  ErrorCodes.UNAUTHORIZED, ex.getResponseBodyAsString());
            });
  }

  // -------------------- helpers --------------------

  private Mono<SsoVerifier.VerifiedIdentity> verifyWithFirstAcceptingVerifier(String ssoToken) {
    if (verifiers.isEmpty()) {
      return Mono.error(
          new CodePilotException(
              ErrorCodes.UNAUTHORIZED, "No SSO method configured on this server"));
    }
    Mono<SsoVerifier.VerifiedIdentity> chain = Mono.empty();
    for (SsoVerifier v : verifiers) {
      chain =
          chain.switchIfEmpty(
              v.verify(ssoToken)
                  .onErrorResume(
                      IllegalArgumentException.class, ex -> Mono.empty())); // fall through
    }
    return chain.switchIfEmpty(
        Mono.error(new CodePilotException(ErrorCodes.UNAUTHORIZED, "Invalid SSO token")));
  }

  private SsoProperties.Oidc.DeviceFlow requireDeviceFlow() {
    if (ssoProps.oidc() == null || ssoProps.oidc().deviceFlow() == null) {
      throw new CodePilotException(
          ErrorCodes.NOT_FOUND, "Device authorization is not configured");
    }
    return ssoProps.oidc().deviceFlow();
  }

  private static org.springframework.util.MultiValueMap<String, String> toMultiValueMap(
      Map<String, String> map) {
    var out = new org.springframework.util.LinkedMultiValueMap<String, String>();
    map.forEach(out::add);
    return out;
  }

  private static String newDeviceSecret() {
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  // -------------------- DTOs --------------------

  public record LoginRequest(@NotBlank String ssoToken) {}

  public record LoginResponse(
      String accessToken,
      Instant accessExpiresAt,
      String refreshToken,
      Instant refreshExpiresAt,
      String deviceSecret) {}

  public record RefreshRequest(@NotBlank String refreshToken) {}

  public record RefreshResponse(String accessToken, Instant accessExpiresAt) {}

  public record MethodsResponse(boolean oidc, boolean hmacBridge, boolean dev, boolean deviceFlow) {}

  /**
   * Reply payload from RFC 8628 device authorization (kept verbatim so the plugin can render it).
   */
  public record DeviceCodeResponse(
      String deviceCode,
      String userCode,
      String verificationUri,
      String verificationUriComplete,
      Long expiresIn,
      Long interval) {}

  public record DeviceTokenRequest(@NotBlank String deviceCode) {}

  /** Standard token response; the plugin will then call /v1/auth/login with {@code idToken}. */
  public record DeviceTokenResponse(
      String accessToken, String idToken, String refreshToken, Long expiresIn, String tokenType) {}
}