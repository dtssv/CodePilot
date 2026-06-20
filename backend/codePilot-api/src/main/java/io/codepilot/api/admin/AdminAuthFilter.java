package io.codepilot.api.admin;

import io.codepilot.common.api.ErrorCodes;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * WebFilter that authenticates admin API requests via a static API key. The key is provided in the
 * {@code X-Admin-API-Key} header and compared against the configured {@code
 * codepilot.admin.api-key} property. Uses constant-time comparison to prevent timing attacks.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class AdminAuthFilter implements WebFilter {

  private static final Logger log = LoggerFactory.getLogger(AdminAuthFilter.class);
  private static final String ADMIN_PATH_PREFIX = "/v1/admin";
  private static final String API_KEY_HEADER = "X-Admin-API-Key";

  private final String adminApiKey;

  public AdminAuthFilter(@Value("${codepilot.admin.api-key:}") String adminApiKey) {
    this.adminApiKey = adminApiKey;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String path = exchange.getRequest().getURI().getPath();
    if (!path.startsWith(ADMIN_PATH_PREFIX)) {
      return chain.filter(exchange);
    }

    // If no admin key is configured, deny all admin access
    if (adminApiKey == null || adminApiKey.isBlank()) {
      log.warn("Admin API accessed but no admin API key is configured");
      return sendError(exchange, ErrorCodes.FORBIDDEN, "Admin access not configured");
    }

    String providedKey = exchange.getRequest().getHeaders().getFirst(API_KEY_HEADER);
    if (providedKey == null || providedKey.isBlank()) {
      return sendError(exchange, ErrorCodes.UNAUTHORIZED, "Missing admin API key");
    }

    // Constant-time comparison
    if (!MessageDigest.isEqual(
        providedKey.getBytes(StandardCharsets.UTF_8),
        adminApiKey.getBytes(StandardCharsets.UTF_8))) {
      log.warn("Invalid admin API key attempt from {}", exchange.getRequest().getRemoteAddress());
      return sendError(exchange, ErrorCodes.UNAUTHORIZED, "Invalid admin API key");
    }

    return chain.filter(exchange);
  }

  private Mono<Void> sendError(ServerWebExchange exchange, int code, String message) {
    HttpStatus status =
        code == ErrorCodes.UNAUTHORIZED ? HttpStatus.UNAUTHORIZED : HttpStatus.FORBIDDEN;
    exchange.getResponse().setStatusCode(status);
    exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
    String body = "{\"code\":" + code + ",\"message\":\"" + message + "\",\"data\":null}";
    DataBuffer buffer =
        exchange.getResponse().bufferFactory().wrap(body.getBytes(StandardCharsets.UTF_8));
    return exchange.getResponse().writeWith(Mono.just(buffer));
  }
}
