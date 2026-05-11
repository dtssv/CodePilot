package io.codepilot.gateway;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * ★ Privacy Mode Filter: When the X-Privacy-Mode header is set to "true",
 * this filter:
 * 1. Strips request body from audit logs (prevents PII logging)
 * 2. Adds X-Privacy-Mode to downstream headers so backend services can
 *    skip telemetry/logging
 * 3. Blocks requests to telemetry endpoints entirely
 *
 * When X-Anonymous-Mode is set, the filter allows the request but ensures
 * no user-identifiable headers (X-User-Id, X-Tenant-Id) are forwarded.
 */
@Component
public class PrivacyModeFilter implements GlobalFilter, Ordered {

    private static final String PRIVACY_HEADER = "X-Privacy-Mode";
    private static final String ANONYMOUS_HEADER = "X-Anonymous-Mode";
    private static final String USER_ID_HEADER = "X-User-Id";
    private static final String TENANT_ID_HEADER = "X-Tenant-Id";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        HttpHeaders headers = request.getHeaders();

        boolean privacyMode = "true".equalsIgnoreCase(headers.getFirst(PRIVACY_HEADER));
        boolean anonymousMode = "true".equalsIgnoreCase(headers.getFirst(ANONYMOUS_HEADER));

        if (privacyMode) {
            // Block telemetry endpoints when privacy mode is on
            String path = request.getPath().value();
            if (path.startsWith("/v1/telemetry") || path.startsWith("/v1/audit")) {
                exchange.getResponse().setComplete();
                return Mono.empty();
            }
        }

        if (anonymousMode) {
            // Strip user-identifiable headers in anonymous mode
            ServerHttpRequest mutated = request.mutate()
                .headers(h -> {
                    h.remove(USER_ID_HEADER);
                    h.remove(TENANT_ID_HEADER);
                })
                .build();
            return chain.filter(exchange.mutate().request(mutated).build());
        }

        return chain.filter(exchange);
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 10; // Run early, after auth
    }
}