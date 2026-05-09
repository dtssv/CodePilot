package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import org.springframework.stereotype.Component;
import java.util.*;

/** Reenter node: merges gathered info into state, jumps back to resumeTo node. */
@Component
public class ReenterAction implements NodeAction<OverAllState> {
    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "reenter");
        GraphSseHelper.emitEvent(state, "graph_info_result",
                Map.of("phaseId", state.value("phaseCursor").orElse("")));
        return updates;
    }

    public String routeAfterReenter(OverAllState state) {
        String resumeTo = (String) state.value("gatherResumeTo").orElse("generate");
        return resumeTo;
    }
}