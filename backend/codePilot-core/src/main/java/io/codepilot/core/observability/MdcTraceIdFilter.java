package io.codepilot.core.observability;

import io.codepilot.common.api.TraceIdHolder;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * WebFilter that ensures the trace ID from the gateway (or client) is propagated into the SLF4J MDC
 * so that all log statements within the request scope include the correlation ID automatically.
 *
 * <p>Lookup order:
 *
 * <ol>
 *   <li>{@code X-CodePilot-Trace-Id} header (set by plugin or gateway)
 *   <li>Generate a new UUID if missing
 * </ol>
 *
 * <p>The trace ID is also echoed in the response header for client-side correlation and set in
 * {@link TraceIdHolder} for programmatic access.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 100)
public class MdcTraceIdFilter implements WebFilter {

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    String traceId = exchange.getRequest().getHeaders().getFirst(TraceIdHolder.HEADER);
    if (traceId == null || traceId.isBlank()) {
      traceId = UUID.randomUUID().toString().replace("-", "");
    }

    MDC.put("traceId", traceId);
    TraceIdHolder.set(traceId);
    exchange.getResponse().getHeaders().set(TraceIdHolder.HEADER, traceId);

    return chain
        .filter(exchange)
        .doFinally(
            signalType -> {
              MDC.remove("traceId");
              TraceIdHolder.clear();
            });
  }
}
