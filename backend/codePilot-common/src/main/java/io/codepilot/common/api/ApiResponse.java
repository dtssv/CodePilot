package io.codepilot.common.api;

import java.time.Instant;

/**
 * Unified, immutable API envelope for non-streaming endpoints.
 *
 * <p>
 * Design goals:
 *
 * <ul>
 * <li>Consistent shape across all modules.
 * <li>Never leaks internal exception text to callers.
 * </ul>
 */
public record ApiResponse<T>(int code, String message, T data, String traceId, Instant ts) {

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(0, "ok", data, TraceIdHolder.current(), Instant.now());
    }

    public static <T> ApiResponse<T> of(int code, String message) {
        return new ApiResponse<>(code, message, null, TraceIdHolder.current(), Instant.now());
    }

    public static <T> ApiResponse<T> of(int code, String message, T data) {
        return new ApiResponse<>(code, message, data, TraceIdHolder.current(), Instant.now());
    }
}