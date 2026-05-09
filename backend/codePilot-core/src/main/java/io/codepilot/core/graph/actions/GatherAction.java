package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import org.springframework.stereotype.Component;
import java.util.*;

/** Gather node: executes read-only info requests (server-side), emits graph_info_request for client-side. */
@Component
public class GatherAction implements NodeAction<OverAllState> {
    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "gather");
        // TODO: validate requests, classify client/server, execute server-side, emit SSE
        GraphSseHelper.emitEvent(state, "graph_info_request",
                Map.of("phaseId", state.value("phaseCursor").orElse(""), "requests", List.of()));
        return updates;
    }
}