package io.codepilot.gateway.filter;

import org.springframework.core.Ordered;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * Content-Security-Policy filter that adds CSP and security headers to all responses.
 *
 * <p>Policy:
 * <ul>
 *   <li>default-src 'self' — only load resources from same origin</li>
 *   <li>script-src 'self' 'unsafe-inline' — allow inline scripts for JCEF React UI</li>
 *   <li>style-src 'self' 'unsafe-inline' — allow inline styles</li>
 *   <li>img-src 'self' data: blob: https: — allow data URIs and images</li>
 *   <li>connect-src 'self' ws: wss: https: — allow WebSocket and API calls</li>
 *   <li>object-src 'none' — no plugins</li>
 *   <li>frame-ancestors 'none' — prevent clickjacking</li>
 * </ul>
 */
@Component
public class CspWebFilter implements WebFilter, Ordered {

    public static final int ORDER = TraceIdWebFilter.ORDER + 5;

    private static final String CSP_POLICY = String.join("; ",
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' ws: wss: https:",
        "font-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
    );

    @Override
    public int getOrder() {
        return ORDER;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        ServerHttpResponse response = exchange.getResponse();
        response.getHeaders().add("Content-Security-Policy", CSP_POLICY);
        response.getHeaders().add("X-Content-Security-Policy", CSP_POLICY);
        response.getHeaders().add("X-Frame-Options", "DENY");
        response.getHeaders().add("X-Content-Type-Options", "nosniff");
        response.getHeaders().add("Referrer-Policy", "strict-origin-when-cross-origin");
        response.getHeaders().add("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        return chain.filter(exchange);
    }
}