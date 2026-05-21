package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import org.springframework.stereotype.Component;
import java.util.*;

/** Reenter node: merges gathered info into state, jumps back to resumeTo node. */
@Component
public class ReenterAction implements NodeAction {
    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "reenter");
        if (io.codepilot.core.graph.PhaseOutcomeHelper.rawToolsHadFailure(state)) {
            if (io.codepilot.core.graph.PhaseGoalHelper.currentStepGoalSatisfied(state)) {
                updates.put("phaseToolsHadFailure", false);
            } else if (!Boolean.TRUE.equals(state.value("approachRepeatBlocked").orElse(false))) {
                int retries = (int) state.value("phaseFailureRetries").orElse(0) + 1;
                updates.put("phaseFailureRetries", retries);
            }
        }
        GraphSseHelper.emitEvent(state, "graph_info_result",
                Map.of("phaseId", state.value("phaseCursor").orElse("")));
        return updates;
    }

    public String routeAfterReenter(OverAllState state) {
        String resumeTo = (String) state.value("gatherResumeTo").orElse("");
        // Only return valid targets that exist in the graph's conditional edge mapping
        return switch (resumeTo) {
            case "planning", "preCheck", "generate", "repair" -> resumeTo;
            default -> "generate"; // safe default
        };
    }
}