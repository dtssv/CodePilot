package io.codepilot.core.graph;

import io.codepilot.core.dto.ConversationRunRequest;
import reactor.core.publisher.FluxSink;

import java.util.Map;

/**
 * Interface for all Graph nodes. Each node executes its logic,
 * may emit SSE events via the sink, and returns a {@link NodeResult}
 * containing the {@link EdgeDecision}.
 */
public interface GraphNode {

    /** Unique node identifier (e.g. "planning", "generate", "gather"). */
    String id();

    /** Execute the node logic. May emit SSE events through the sink. */
    NodeResult execute(GraphState state, ConversationRunRequest request, FluxSink<Map<String, Object>> sink);
}