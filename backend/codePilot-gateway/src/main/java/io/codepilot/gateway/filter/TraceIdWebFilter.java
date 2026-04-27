package io.codepilot.gateway.filter;

import io.codepilot.common.api.TraceIdHolder;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;
import reactor.util.context.Context;

/**
 * Ensures every incoming request carries a trace id and that downstream code can read it both via
 * {@link TraceIdHolder} (servlet/blocking) and the reactor {@link Context} (reactive). The id is
 * also echoed back in the response header for client-side correlation.
 *
 * <p>Order: <strong>first</strong> in the chain so that all subsequent filters can use the trace
 * id when logging/audit.
 */
@Component
public class TraceIdWebFilter implements WebFilter, Ordered {

  public static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 100;
  public static final String CTX_KEY = "traceId";

  @Override
  public int getOrder() {
    return ORDER;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    HttpHeaders headers = exchange.getRequest().getHeaders();
    String traceId = headers.getFirst(TraceIdHolder.HEADER);
    if (traceId == null || traceId.isBlank()) {
      traceId = UUID.randomUUID().toString().replace("-", "");
    }
    String finalTraceId = traceId;

    ServerHttpResponse response = exchange.getResponse();
    response.getHeaders().set(TraceIdHolder.HEADER, finalTraceId);

    return chain
        .filter(exchange)
        .doOnEach(
            signal -> {
              // Propagate to MDC and ThreadLocal for any blocking-style downstream code.
              if (signal.isOnNext() || signal.isOnError() || signal.isOnComplete()) {
                MDC.put(CTX_KEY, finalTraceId);
                TraceIdHolder.set(finalTraceId);
              }
            })
        .doFinally(
            sig -> {
              MDC.remove(CTX_KEY);
              TraceIdHolder.clear();
            })
        .contextWrite(Context.of(CTX_KEY, finalTraceId));
  }
}