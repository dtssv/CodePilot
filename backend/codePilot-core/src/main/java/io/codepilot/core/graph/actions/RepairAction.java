package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Component;
import java.util.*;

/**
 * Repair node: LLM produces minimal fix patch based on VerifyReport.
 * Tracks attempt count — if exhausted, marks the user plan step as failed
 * and escalates to AskUser.
 */
@Component
public class RepairAction implements NodeAction<OverAllState> {

    private static final int DEFAULT_MAX_ATTEMPTS = 3;
    private final ChatClient chatClient;

    public RepairAction(ChatClient chatClient) { this.chatClient = chatClient; }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "repair");
        String phaseId = (String) state.value("phaseCursor").orElse("");

        // Track attempts
        var attempts = (Map<String, Integer>) state.value("attempts").orElse(new HashMap<>());
        int count = attempts.getOrDefault(phaseId, 0) + 1;
        attempts.put(phaseId, count);
        updates.put("attempts", attempts);

        if (count >= DEFAULT_MAX_ATTEMPTS) {
            // Budget exhausted → update user plan step to failed, escalate to askUser
            GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS,
                Map.of("stepId", phaseId, "status", "failed",
                       "message", "Repair failed after " + count + " attempts, need your input"));
            GraphSseHelper.emitEvent(state, SseEvents.GRAPH_BUDGET_ALERT,
                Map.of("phaseId", phaseId, "kind", "attempts", "value", count, "limit", DEFAULT_MAX_ATTEMPTS));
            updates.put("repairResult", "askUser");
            return updates;
        }

        // TODO: invoke chatClient with graph.repair(verifyReport) prompt
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_REPAIR_PLAN,
            Map.of("phaseId", phaseId, "attempt", count, "strategy", "minimal-patch"));
        updates.put("repairResult", "toolCalls");
        return updates;
    }

    public String routeAfterRepair(OverAllState state) {
        String result = (String) state.value("repairResult").orElse("toolCalls");
        return switch (result) {
            case "infoRequests" -> "gather";
            case "askUser" -> "askUser";
            default -> "applyPatch";
        };
    }
}