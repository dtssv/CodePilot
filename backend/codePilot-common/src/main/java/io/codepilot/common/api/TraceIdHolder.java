package io.codepilot.common.api;

/**
 * Propagates the current request trace id through reactive / servlet contexts.
 *
 * <p>
 * The reactive adapter is wired in {@code GatewayTraceIdWebFilter}; the servlet
 * fallback is in
 * {@code MdcTraceIdFilter}. Consumers access the value through
 * {@link #current()}.
 */
public final class TraceIdHolder {

    public static final String HEADER = "X-CodePilot-Trace-Id";
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private TraceIdHolder() {
    }

    public static void set(String traceId) {
        CURRENT.set(traceId);
    }

    public static String current() {
        String id = CURRENT.get();
        return id == null ? "" : id;
    }

    public static void clear() {
        CURRENT.remove();
    }
}