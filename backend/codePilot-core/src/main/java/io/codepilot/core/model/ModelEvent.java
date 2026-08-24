package io.codepilot.core.model;

import java.util.List;

/**
 * Sealed model event interface — mirrors harness-core's
 * {@code io.codepilot.harness.model.ModelEvent}.
 *
 * <p>Emitted over the gateway SSE stream as NDJSON; the plugin's
 * HTTP ChatModel adapter deserializes them back into ModelEvent instances.
 */
public sealed interface ModelEvent
        permits ModelEvent.TextDelta, ModelEvent.AssistantToolCall,
                ModelEvent.StopReason, ModelEvent.UsageReport, ModelEvent.Error {

    /** Incremental text chunk from the assistant. */
    record TextDelta(String text) implements ModelEvent {}

    /** A tool call requested by the assistant. */
    record AssistantToolCall(String callId, String name, String argumentsJson) implements ModelEvent {}

    /** Why the stream ended. */
    record StopReason(Kind kind, String detail) implements ModelEvent {
        public enum Kind { END_TURN, TOOL_USE, MAX_TOKENS, ERROR }
    }

    /** Token usage (for billing). */
    record UsageReport(long inputTokens, long outputTokens) implements ModelEvent {}

    /** Stream-level error (transport errors are handled by the gateway HTTP layer). */
    record Error(String message) implements ModelEvent {}
}
