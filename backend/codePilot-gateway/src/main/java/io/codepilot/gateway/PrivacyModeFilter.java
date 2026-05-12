package io.codepilot.gateway;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * ★ Privacy Mode Filter: When the {@code X-CodePilot-Privacy} header is set to "strict",
 * this filter:
 * <ol>
 *   <li>Blocks requests to telemetry/audit endpoints entirely</li>
 *   <li>Adds {@code X-CodePilot-Data-Retained: none} response header</li>
 *   <li>Strips user-identifiable headers (X-User-Id, X-Tenant-Id) from downstream</li>
 *   <li>Propagates the privacy flag via {@code X-CodePilot-Privacy} to backend services
 *       so they can skip Redis caching, audit writes, and telemetry</li>
 * </ol>
 *
 * <p>When X-Anonymous-Mode is set, the filter allows the request but ensures
 * no user-identifiable headers are forwarded.
 */
@Component
public class PrivacyModeFilter implements GlobalFilter, Ordered {

    private static final String PRIVACY_HEADER = "X-CodePilot-Privacy";
    private static final String ANONYMOUS_HEADER = "X-Anonymous-Mode";
    private static final String USER_ID_HEADER = "X-User-Id";
    private static final String TENANT_ID_HEADER = "X-Tenant-Id";
    private static final String DATA_RETAINED_HEADER = "X-CodePilot-Data-Retained";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();
        HttpHeaders headers = request.getHeaders();

        boolean privacyStrict = "strict".equalsIgnoreCase(headers.getFirst(PRIVACY_HEADER));
        boolean anonymousMode = "true".equalsIgnoreCase(headers.getFirst(ANONYMOUS_HEADER));

        if (privacyStrict) {
            // Block telemetry/audit endpoints when privacy mode is strict
            String path = request.getPath().value();
            if (path.startsWith("/v1/telemetry") || path.startsWith("/v1/audit")) {
                exchange.getResponse().setComplete();
                return Mono.empty();
            }

            // Strip user-identifiable headers in strict privacy mode
            ServerHttpRequest mutated = request.mutate()
                .headers(h -> {
                    h.remove(USER_ID_HEADER);
                    h.remove(TENANT_ID_HEADER);
                    // Ensure the privacy header is forwarded to backend services
                    h.set(PRIVACY_HEADER, "strict");
                })
                .build();

            // Add response header indicating no data retained
            ServerHttpResponse response = exchange.getResponse();
            response.getHeaders().add(DATA_RETAINED_HEADER, "none");
            response.getHeaders().add("X-CodePilot-Privacy-Acknowledged", "true");

            return chain.filter(exchange.mutate().request(mutated).build());
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