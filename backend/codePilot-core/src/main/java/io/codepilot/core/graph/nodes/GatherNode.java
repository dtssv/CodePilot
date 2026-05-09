package io.codepilot.core.graph.nodes;

import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.graph.*;
import io.codepilot.core.graph.gather.InfoRequestDispatcher;
import io.codepilot.core.graph.gather.InfoRequestValidator;
import io.codepilot.core.graph.sse.GraphSseEmitter;
import org.springframework.stereotype.Component;
import reactor.core.publisher.FluxSink;

import java.util.List;
import java.util.Map;

/**
 * Gather node: executes read-only info requests (server-side portion),
 * emits graph_info_request for client-side requests, awaits results,
 * then transitions to Reenter.
 */
@Component
public class GatherNode implements GraphNode {

    private final InfoRequestValidator validator;
    private final InfoRequestDispatcher dispatcher;
    private final GraphSseEmitter sseEmitter;

    public GatherNode(InfoRequestValidator validator,
                      InfoRequestDispatcher dispatcher,
                      GraphSseEmitter sseEmitter) {
        this.validator = validator;
        this.dispatcher = dispatcher;
        this.sseEmitter = sseEmitter;
    }

    @Override
    public String id() {
        return "gather";
    }

    @Override
    public NodeResult execute(GraphState state, ConversationRunRequest request, FluxSink<Map<String, Object>> sink) {
        List<Map<String, Object>> requests = state.getPendingGatherRequests();
        if (requests == null || requests.isEmpty()) {
            // No pending requests, skip to reenter
            return new NodeResult("reenter", "no-requests", new EdgeDecision.Go("reenter"));
        }

        // Validate
        validator.validate(requests);

        // Classify into client-side and server-side
        var dispatch = dispatcher.classify(requests);

        // Emit SSE for client-side requests (plugin will execute and respond)
        if (!dispatch.clientSide().isEmpty()) {
            sink.next(sseEmitter.infoRequest(state.getPhaseCursor(), dispatch.clientSide()));
        }

        // Execute server-side requests immediately
        if (!dispatch.serverSide().isEmpty()) {
            List<Map<String, Object>> serverResults = dispatcher.executeServerSide(dispatch.serverSide());
            state.addGatheredResults(serverResults);
        }

        // Transition to reenter (client results will arrive via tool-result callback)
        return new NodeResult("reenter", "gathered", new EdgeDecision.Go("reenter"));
    }
}