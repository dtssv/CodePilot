package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import java.util.*;

/**
 * Finalize node (terminal): summarizes results, archives completed tool calls,
 * writes session digest, and emits the final SSE event.
 *
 * Flow:
 * 1. Generate task summary from plan + ledger + tool call results
 * 2. Write sessionDigest to state for client persistence
 * 3. Archive completedToolCalls for resume capability
 * 4. Emit done(final) SSE with summary
 */
@Component
public class FinalizeAction implements NodeAction {
    private static final Logger log = LoggerFactory.getLogger(FinalizeAction.class);

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "finalize");
        updates.put("doneReason", "final");

        String sessionId = (String) state.value("sessionId").orElse("");
        var phases = (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        var completedToolCalls = (List<Map<String, Object>>) state.value("completedToolCalls").orElse(List.of());
        var taskLedger = (Map<String, Object>) state.value("taskLedger").orElse(Map.of());
        var patchResults = (List<Map<String, Object>>) state.value("patchResults").orElse(List.of());

        // 1. Generate task summary
        StringBuilder summary = new StringBuilder();
        String goal = (String) taskLedger.getOrDefault("goal", "");
        if (!goal.isEmpty()) {
            summary.append("Goal: ").append(goal).append("\n\n");
        }

        // Summarize phase results
        int completedPhases = 0;
        int failedPhases = 0;
        List<String> changedFiles = new ArrayList<>();
        for (var phase : phases) {
            String status = (String) phase.getOrDefault("status", "unknown");
            if ("completed".equals(status) || "success".equals(status)) {
                completedPhases++;
            } else if ("failed".equals(status)) {
                failedPhases++;
            }
        }

        // Collect changed files from patch results
        for (var pr : patchResults) {
            String path = (String) pr.getOrDefault("path", "");
            Boolean success = (Boolean) pr.getOrDefault("success", false);
            if (!path.isEmpty() && success) {
                changedFiles.add(path);
            }
        }

        summary.append("Phases completed: ").append(completedPhases);
        if (failedPhases > 0) {
            summary.append(", failed: ").append(failedPhases);
        }
        summary.append(" out of ").append(phases.size()).append("\n");

        if (!changedFiles.isEmpty()) {
            summary.append("Files changed: ").append(String.join(", ", changedFiles)).append("\n");
        }

        summary.append("Tool calls executed: ").append(completedToolCalls.size()).append("\n");

        // 2. Build session digest for persistence
        Map<String, Object> sessionDigest = new HashMap<>();
        sessionDigest.put("summary", summary.toString());
        sessionDigest.put("goal", goal);
        sessionDigest.put("completedPhases", completedPhases);
        sessionDigest.put("totalPhases", phases.size());
        sessionDigest.put("changedFiles", changedFiles);
        sessionDigest.put("completedToolCallsCount", completedToolCalls.size());
        sessionDigest.put("timestamp", System.currentTimeMillis());
        updates.put("sessionDigest", sessionDigest);

        // 3. Build summaryForNextTurn for bidirectional memory
        Map<String, Object> nextTurnSummary = new HashMap<>();
        nextTurnSummary.put("taskCompleted", true);
        nextTurnSummary.put("changedFiles", changedFiles);
        nextTurnSummary.put("toolCallCount", completedToolCalls.size());
        nextTurnSummary.put("summaryText", summary.toString());
        updates.put("summaryForNextTurn", nextTurnSummary);

        // 4. Emit finalize events
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PHASE_DONE,
            Map.of("phaseId", "finalize", "summary", summary.toString()));

        GraphSseHelper.emitEvent(state, SseEvents.DONE,
            Map.of(
                "reason", "final",
                "summary", summary.toString(),
                "changedFiles", changedFiles,
                "completedPhases", completedPhases,
                "totalPhases", phases.size()
            ));

        log.info("Finalize: task completed. {} phases done, {} files changed, {} tool calls",
            completedPhases, changedFiles.size(), completedToolCalls.size());
        return updates;
    }
}