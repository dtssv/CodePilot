package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.springframework.stereotype.Component;
import java.util.*;

/**
 * Commit node: marks current phase done, advances to next phase, and
 * emits user_plan_progress to update the user-facing plan step status.
 */
@Component
public class CommitAction implements NodeAction {
    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "commit");
        String phaseId = (String) state.value("phaseCursor").orElse("");

        // Emit graph_phase_done (execution layer)
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PHASE_DONE,
            Map.of("phaseId", phaseId, "summary", "Phase " + phaseId + " completed"));

        // ── Update User Plan progress (user layer) ──
        // Find the corresponding user step and mark it completed
        GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS,
            Map.of(
                "stepId", phaseId,
                "status", "completed",
                "message", "Phase completed successfully"
            ));

        // Advance to next phase
        var phases = (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        int currentIdx = -1;
        for (int i = 0; i < phases.size(); i++) {
            if (phaseId.equals(phases.get(i).get("id"))) {
                currentIdx = i;
                break;
            }
        }
        boolean hasNext = currentIdx >= 0 && currentIdx < phases.size() - 1;
        updates.put("hasNextPhase", hasNext);
        if (hasNext) {
            String nextPhaseId = (String) phases.get(currentIdx + 1).get("id");
            updates.put("phaseCursor", nextPhaseId);
            // Mark next user step as in_progress
            GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS,
                Map.of("stepId", nextPhaseId, "status", "in_progress", "message", "Starting phase"));
        }
        return updates;
    }

    public String routeAfterCommit(OverAllState state) {
        Boolean hasNext = (Boolean) state.value("hasNextPhase").orElse(false);
        return hasNext ? "preCheck" : "finalize";
    }
}