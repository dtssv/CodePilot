package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.PhaseGoalHelper;
import io.codepilot.core.graph.ShellCommandGate;
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
        // Prevent the graph runner from re-routing on a stale generateResult after this terminal node.
        updates.put("generateResult", null);
        boolean goalUnmet = Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false))
                || !PhaseGoalHelper.overallCompileRunGoalMet(state);
        // Always mark the graph run as finished; goalUnmet is informational for the client UI.
        updates.put("doneReason", "final");
        updates.put("goalUnmet", goalUnmet);

        String sessionId = (String) state.value("sessionId").orElse("");
        var phases = (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        var completedToolCalls = (List<Map<String, Object>>) state.value("completedToolCalls").orElse(List.of());
        var directToolsExecuted =
                (List<Map<String, Object>>) state.value("directToolsExecuted").orElse(List.of());
        var taskLedger = (Map<String, Object>) state.value("taskLedger").orElse(Map.of());
        var patchResults = (List<Map<String, Object>>) state.value("patchResults").orElse(List.of());

        // 1. Generate task summary
        StringBuilder summary = new StringBuilder();
        String goal = (String) taskLedger.getOrDefault("goal", "");
        if (!goal.isEmpty()) {
            summary.append("Goal: ").append(goal).append("\n\n");
        }

        // Summarize phase results (CommitAction records completed phase ids in state)
        @SuppressWarnings("unchecked")
        List<String> completedPhaseIds =
                (List<String>) state.value("completedPhases").orElse(List.of());
        int phasesDone = completedPhaseIds.size();
        int failedPhases = 0;
        List<String> changedFiles = new ArrayList<>();
        for (var phase : phases) {
            String status = (String) phase.getOrDefault("status", "unknown");
            if ("failed".equals(status)) {
                failedPhases++;
            }
        }
        if (phasesDone == 0 && !phases.isEmpty() && failedPhases == 0) {
            phasesDone = phases.size();
        }
        int completedPhases = phasesDone;

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

        int toolCallCount = Math.max(completedToolCalls.size(), directToolsExecuted.size());
        summary.append("Tool calls executed: ").append(toolCallCount).append("\n");

        if (goalUnmet && ShellCommandGate.isCompileRunIntent((String) state.value("input").orElse(""))) {
            summary.append("\n⚠ User goal (compile and run) was not fully verified.\n");
            if (!Boolean.TRUE.equals(state.value("sessionHadSuccessfulCompile").orElse(false))) {
                summary.append("- No successful compile command was recorded.\n");
            }
            if (!Boolean.TRUE.equals(state.value("sessionHadSuccessfulRun").orElse(false))) {
                summary.append("- No successful run of the built executable was recorded.\n");
            }
            summary.append("Try running the binary directly (e.g. ./main_program or ./build/test).\n");
        }

        // 2. Build session digest for persistence
        Map<String, Object> sessionDigest = new HashMap<>();
        sessionDigest.put("summary", summary.toString());
        sessionDigest.put("goal", goal);
        sessionDigest.put("completedPhases", completedPhases);
        sessionDigest.put("totalPhases", phases.size());
        sessionDigest.put("changedFiles", changedFiles);
        sessionDigest.put("completedToolCallsCount", toolCallCount);
        sessionDigest.put("timestamp", System.currentTimeMillis());
        updates.put("sessionDigest", sessionDigest);

        // 3. Build summaryForNextTurn for bidirectional memory
        Map<String, Object> nextTurnSummary = new HashMap<>();
        nextTurnSummary.put("taskCompleted", true);
        nextTurnSummary.put("changedFiles", changedFiles);
        nextTurnSummary.put("toolCallCount", toolCallCount);
        nextTurnSummary.put("summaryText", summary.toString());
        updates.put("summaryForNextTurn", nextTurnSummary);

        // 4. Emit finalize events
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PHASE_DONE,
            Map.of("phaseId", "finalize", "summary", summary.toString()));

        GraphSseHelper.emitEvent(state, SseEvents.DONE,
            Map.of(
                "reason", "final",
                "goalUnmet", goalUnmet,
                "summary", summary.toString(),
                "changedFiles", changedFiles,
                "completedPhases", completedPhases,
                "totalPhases", phases.size()
            ));

        log.info(
            "Finalize: task completed. {} phases done, {} files changed, {} tool calls (direct={})",
            completedPhases,
            changedFiles.size(),
            toolCallCount,
            directToolsExecuted.size());
        return updates;
    }
}