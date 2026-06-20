package io.codepilot.gateway.filter;

import org.springframework.core.Ordered;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * Prevents the Spring Framework SSE bug where {@code ServerSentEventHttpMessageWriter} tries to set
 * {@code Content-Type} on already-committed Spring Cloud Gateway response headers.
 *
 * <p>This filter sets {@code Content-Type: text/event-stream} early on the response for endpoints
 * that produce SSE, before any other filter commits the response. This way the SSE writer's
 * redundant setContentType call becomes a no-op instead of throwing UnsupportedOperationException.
 */
@Component
public class SseContentTypeFilter implements WebFilter, Ordered {

  /**
   * Must run before filters that commit the response (JwtAuth et al) but after security filters.
   * This must be one of the first filters in the chain.
   */
  public static final int ORDER = TraceIdWebFilter.ORDER + 5;

  @Override
  public int getOrder() {
    return ORDER;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String path = exchange.getRequest().getURI().getPath();
    // Set Content-Type early for SSE endpoints to avoid ReadOnlyHttpHeaders error.
    // Match ONLY the streaming endpoints — never the JSON ones such as
    // /v1/conversation/runs/admission or /v1/conversation/runs/{id}/status, whose
    // bodies must not be SSE-framed (otherwise the plugin fails to parse them).
    if (isSseEndpoint(path)) {
      exchange.getResponse().getHeaders().setContentType(MediaType.TEXT_EVENT_STREAM);
    }
    return chain.filter(exchange);
  }

  private static boolean isSseEndpoint(String path) {
    return path.equals("/v1/conversation/run")
        || path.equals("/v1/conversation/resume")
        || path.equals("/v1/conversation/dream")
        || path.equals("/v1/conversation/distill")
        || path.equals("/v1/conversation/fork")
        || path.equals("/v1/conversation/fork/batch")
        || (path.startsWith("/v1/conversation/runs/") && path.endsWith("/stream"));
  }
}
