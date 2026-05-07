package io.codepilot.gateway.filter;

import io.codepilot.common.api.ErrorCodes;
import io.codepilot.gateway.security.AuthPrincipal;
import io.codepilot.gateway.security.JwtService;
import io.codepilot.gateway.web.WebErrors;
import java.util.Set;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;
import reactor.util.context.Context;

/**
 * Authenticates requests by verifying the {@code Authorization: Bearer <jwt>} header. The
 * resulting {@link AuthPrincipal} is injected into the reactor {@link Context} under {@link
 * AuthPrincipal#CTX_KEY}. Public endpoints bypass this filter.
 *
 * <p>Runs <em>after</em> HMAC verification so only signed requests reach this point.
 */
@Component
public class JwtAuthWebFilter implements WebFilter, Ordered {

  public static final int ORDER = HmacSignatureWebFilter.ORDER + 10;

  private static final Set<String> PUBLIC_PATHS =
      Set.of(
          "/actuator",
          "/v3/api-docs",
          "/swagger-ui",
          "/webjars/",
          "/favicon.ico",
          "/v1/version",
          "/v1/auth/login",
          "/v1/auth/refresh",
          "/v1/auth/methods",
          "/v1/auth/device-code",
          "/v1/auth/device-token");

  private static final String DEV_TOKEN_HEADER = "X-CodePilot-Dev-Token";

  private final JwtService jwt;

  /** Dev token for bypassing JWT in development builds. Set via codepilot.security.dev-token. */
  private final String devToken;

  public JwtAuthWebFilter(JwtService jwt,
      @org.springframework.beans.factory.annotation.Value("${codepilot.security.dev-token:}") String devToken) {
    this.jwt = jwt;
    this.devToken = devToken.isBlank() ? null : devToken;
  }

  @Override
  public int getOrder() {
    return ORDER;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String path = exchange.getRequest().getPath().pathWithinApplication().value();
    if (isPublic(path)) {
      return chain.filter(exchange);
    }

    // Dev token bypass: if a valid dev token header is present, create a dev principal and skip JWT
    String reqDevToken = exchange.getRequest().getHeaders().getFirst(DEV_TOKEN_HEADER);
    if (reqDevToken != null && !reqDevToken.isBlank() && isValidDevToken(reqDevToken)) {
      String deviceId = exchange.getRequest().getHeaders().getFirst("X-CodePilot-Device-Id");
      if (deviceId == null || deviceId.isBlank()) deviceId = "dev-device";
      AuthPrincipal devPrincipal = new AuthPrincipal(
          "dev-user", "dev-tenant", deviceId,
          java.util.Set.of("user", "dev"), Long.MAX_VALUE);
      return chain.filter(exchange).contextWrite(Context.of(AuthPrincipal.CTX_KEY, devPrincipal));
    }

    String header = exchange.getRequest().getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
    if (header == null || !header.regionMatches(true, 0, "Bearer ", 0, 7)) {
      return WebErrors.write(exchange, ErrorCodes.UNAUTHORIZED, "Missing bearer token", 401);
    }
    String token = header.substring(7).trim();
    AuthPrincipal principal;
    try {
      principal = jwt.verify(token);
    } catch (IllegalArgumentException ex) {
      return WebErrors.write(exchange, ErrorCodes.UNAUTHORIZED, "Invalid or expired token", 401);
    }
    return chain.filter(exchange).contextWrite(Context.of(AuthPrincipal.CTX_KEY, principal));
  }

  private boolean isPublic(String path) {
    for (String p : PUBLIC_PATHS) {
      if (path.equals(p) || path.startsWith(p + "/") || path.startsWith(p)) return true;
    }
    return false;
  }

  /**
   * Checks if the provided dev token matches the configured dev token.
   * Uses constant-time comparison to prevent timing attacks.
   */
  private boolean isValidDevToken(String token) {
    if (devToken == null || devToken.isEmpty()) return false;
    return java.security.MessageDigest.isEqual(
        token.getBytes(java.nio.charset.StandardCharsets.UTF_8),
        devToken.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  }
}
