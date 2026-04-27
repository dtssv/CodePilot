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

  private final JwtService jwt;

  public JwtAuthWebFilter(JwtService jwt) {
    this.jwt = jwt;
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
}