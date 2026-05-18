package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.conversation.SseFactory;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Sinks;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Utility to accumulate SSE events into the graph OverAllState during node execution,
 * and simultaneously emit them to a reactive {@link Sinks.Many} for real-time streaming.
 *
 * <p>Events are collected in state["sseEvents"] for post-hoc retrieval (backward compat),
 * AND pushed to the liveSink so that {@link GraphEngineService} can stream them immediately
 * to the client without waiting for the entire graph to complete.
 *
 * <p>M1 fix: The live sink and SSE factory are now stored in a static ConcurrentHashMap
 * keyed by sessionId, instead of relying solely on ThreadLocal. This is reliable when the
 * StateGraph framework switches threads for async nodes, whereas ThreadLocal would be lost
 * on thread change. The sessionId-based lookup is thread-safe and survives any thread
 * switches performed by the graph framework.
 */
public final class GraphSseHelper {

    private GraphSseHelper() {}

    /** Static ConcurrentHashMap for live sinks, keyed by sessionId. Thread-safe across thread switches. */
    private static final ConcurrentHashMap<String, Sinks.Many<ServerSentEvent<String>>> SESSION_SINKS =
            new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, SseFactory> SESSION_SSE_FACTORIES =
            new ConcurrentHashMap<>();

    /**
     * Thread-local fallback: still set by GraphEngineService for backward compatibility
     * with nodes that might not have access to sessionId.
     */
    private static final ThreadLocal<Sinks.Many<ServerSentEvent<String>>> LIVE_SINK =
            new ThreadLocal<>();
    private static final ThreadLocal<SseFactory> SSE_FACTORY =
            new ThreadLocal<>();

    /** Registers the live sink for a session (survives thread switches in async nodes). */
    public static void registerSessionSink(String sessionId, Sinks.Many<ServerSentEvent<String>> sink, SseFactory sse) {
        SESSION_SINKS.put(sessionId, sink);
        SESSION_SSE_FACTORIES.put(sessionId, sse);
        // Also set ThreadLocal for backward compatibility
        LIVE_SINK.set(sink);
        SSE_FACTORY.set(sse);
    }

    /** Removes the session sink when the graph execution completes. */
    public static void unregisterSessionSink(String sessionId) {
        SESSION_SINKS.remove(sessionId);
        SESSION_SSE_FACTORIES.remove(sessionId);
    }

    /** Snapshot of sessions with an active graph SSE sink on this JVM. */
    public static java.util.Set<String> activeSessionIds() {
        return java.util.Set.copyOf(SESSION_SINKS.keySet());
    }

    /**
     * Best-effort terminal event for deploy drain / stop (session may be on another thread).
     */
    public static void emitTerminalDone(String sessionId, String eventType, Object data) {
        if (sessionId == null || sessionId.isBlank()) {
            return;
        }
        var sink = SESSION_SINKS.get(sessionId);
        var sse = SESSION_SSE_FACTORIES.get(sessionId);
        if (sink == null || sse == null) {
            return;
        }
        try {
            sink.tryEmitNext(sse.event(eventType, data));
            sink.tryEmitComplete();
        } catch (Exception ignored) {
            // sink may already be terminated
        }
    }

    public static void setLiveSink(Sinks.Many<ServerSentEvent<String>> sink, SseFactory sse) {
        LIVE_SINK.set(sink);
        SSE_FACTORY.set(sse);
    }

    public static void clearLiveSink() {
        LIVE_SINK.remove();
        SSE_FACTORY.remove();
    }

    @SuppressWarnings("unchecked")
    public static void emitEvent(OverAllState state, String eventType, Object data) {
        // 1. Accumulate in state for backward compatibility
        var events = (List<Map<String, Object>>) state.value("sseEvents")
                .orElseGet(ArrayList::new);
        events.add(Map.of("event", eventType, "data", data));

        // 2. Get sink: try sessionId-based lookup first (M1 fix — survives thread switches),
        //    then ThreadLocal fallback
        Sinks.Many<ServerSentEvent<String>> sink = null;
        SseFactory sse = null;

        // Try sessionId-based lookup (reliable across thread switches in AsyncNodeAction)
        String sessionId = (String) state.value("sessionId").orElse("");
        if (!sessionId.isEmpty()) {
            sink = SESSION_SINKS.get(sessionId);
            sse = SESSION_SSE_FACTORIES.get(sessionId);
        }

        // Fallback to ThreadLocal (for nodes that don't have state, or legacy code)
        if (sink == null) {
            sink = LIVE_SINK.get();
            sse = SSE_FACTORY.get();
        }

        // 3. Emit to live sink for real-time SSE streaming
        if (sink != null && sse != null) {
            try {
                sink.tryEmitNext(sse.event(eventType, data));
            } catch (Exception e) {
                // Sink may be closed or terminated; ignore
            }
        }
    }
}