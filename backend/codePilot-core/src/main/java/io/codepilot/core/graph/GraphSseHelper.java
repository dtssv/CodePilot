package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Utility to accumulate SSE events into the graph OverAllState during node execution.
 * Events are collected in state["sseEvents"] and emitted after graph completion.
 */
public final class GraphSseHelper {

    private GraphSseHelper() {}

    @SuppressWarnings("unchecked")
    public static void emitEvent(OverAllState state, String eventType, Object data) {
        var events = (List<Map<String, Object>>) state.value("sseEvents")
                .orElseGet(ArrayList::new);
        events.add(Map.of("event", eventType, "data", data));
        // Note: OverAllState is mutable during node execution in Spring AI Alibaba Graph
    }
}