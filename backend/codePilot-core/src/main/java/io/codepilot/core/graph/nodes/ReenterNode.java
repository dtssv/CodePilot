package io.codepilot.core.graph.nodes;

import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.graph.*;
import io.codepilot.core.graph.sse.GraphSseEmitter;
import org.springframework.stereotype.Component;
import reactor.core.publisher.FluxSink;

import java.util.Map;

/**
 * Reenter node: merges gathered info into state.gathered[],
 * emits graph_info_result, then jumps back to the resumeTo node.
 * Attempts counter is NOT incremented.
 */
@Component
public class ReenterNode implements GraphNode {

    private final GraphSseEmitter sseEmitter;

    public ReenterNode(GraphSseEmitter sseEmitter) {
        this.sseEmitter = sseEmitter;
    }

    @Override
    public String id() {
        return "reenter";
    }

    @Override
    public NodeResult execute(GraphState state, ConversationRunRequest request, FluxSink<Map<String, Object>> sink) {
        // Emit info result event
        sink.next(sseEmitter.infoResult(state.getPhaseCursor(), state.getGathered()));

        // Determine where to jump back
        String resumeTo = state.getGatherResumeTo();
        state.clearGatherRequest();

        if (resumeTo == null || resumeTo.isBlank()) {
            resumeTo = "generate"; // default fallback
        }

        return new NodeResult(resumeTo, "reenter-complete", new EdgeDecision.Go(resumeTo));
    }
}