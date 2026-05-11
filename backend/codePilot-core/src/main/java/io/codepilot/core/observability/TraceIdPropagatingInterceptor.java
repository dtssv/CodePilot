package io.codepilot.core.observability;

import io.codepilot.common.api.TraceIdHolder;
import java.io.IOException;
import okhttp3.Interceptor;
import okhttp3.Request;
import okhttp3.Response;
import org.slf4j.MDC;

/**
 * OkHttp interceptor that injects the current trace ID into outbound LLM
 * Provider requests. This enables end-to-end correlation from the IDE
 * plugin through the gateway, service layer, and out to the LLM provider.
 *
 * <p>Injection targets:
 * <ul>
 *   <li>{@code X-CodePilot-Trace-Id} — for internal correlation</li>
 *   <li>{@code traceparent} — W3C Trace Context standard header (if OTel enabled)</li>
 * </ul>
 *
 * <p>The trace ID is read from {@link TraceIdHolder} (ThreadLocal) first,
 * falling back to the SLF4J MDC.
 */
public class TraceIdPropagatingInterceptor implements Interceptor {

    @Override
    public Response intercept(Chain chain) throws IOException {
        Request original = chain.request();

        String traceId = TraceIdHolder.current();
        if (traceId.isEmpty()) {
            traceId = MDC.get("traceId");
        }

        if (traceId == null || traceId.isEmpty()) {
            return chain.proceed(original);
        }

        Request.Builder builder = original.newBuilder()
                .header(TraceIdHolder.HEADER, traceId);

        // Also set W3C traceparent header for OTel-compatible providers
        // Format: traceparent: 00-{traceId}-{spanId}
        // We use a fixed spanId of 16 hex zeros for the LLM call span
        if (traceId.length() == 32) {
            builder.header("traceparent", "00-" + traceId + "-0000000000000000");
        }

        return chain.proceed(builder.build());
    }
}