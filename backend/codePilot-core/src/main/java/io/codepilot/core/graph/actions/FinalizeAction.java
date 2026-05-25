package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.*;
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

    private final io.codepilot.core.memory.ProjectMemoryStore projectMemoryStore;

    public FinalizeAction(io.codepilot.core.memory.ProjectMemoryStore projectMemoryStore) {
        this.projectMemoryStore = projectMemoryStore;
    }

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

        // 2. Build session digest for persistence (enriched with structured fields)
        Map<String, Object> sessionDigest = new HashMap<>();
        sessionDigest.put("summary", summary.toString());
        sessionDigest.put("goal", goal);
        sessionDigest.put("completedPhases", completedPhases);
        sessionDigest.put("totalPhases", phases.size());
        sessionDigest.put("changedFiles", changedFiles);
        sessionDigest.put("completedToolCallsCount", toolCallCount);
        sessionDigest.put("timestamp", System.currentTimeMillis());
        // ── Enriched structured fields (four-layer memory) ──
        // Extract architecture decisions from journal
        List<String> archDecisions = extractArchitectureDecisions(state);
        if (!archDecisions.isEmpty()) {
            sessionDigest.put("architectureDecisions", archDecisions);
        }
        // Extract rejected approaches from journal
        List<String> rejectedApproaches = extractRejectedApproaches(state);
        if (!rejectedApproaches.isEmpty()) {
            sessionDigest.put("rejectedApproaches", rejectedApproaches);
        }
        // Change lineage
        List<Map<String, Object>> changeLineage =
                (List<Map<String, Object>>) state.value("changeLineage").orElse(List.of());
        if (!changeLineage.isEmpty()) {
            sessionDigest.put("changeLineage", changeLineage.stream()
                    .map(e -> {
                        Map<String, Object> m = new HashMap<>();
                        m.put("path", e.getOrDefault("filePath", ""));
                        m.put("reason", e.getOrDefault("patchContent", ""));
                        m.put("phaseId", e.getOrDefault("phaseId", ""));
                        return m;
                    })
                    .toList());
        }
        // Memory anomalies
        List<String> anomalies =
                (List<String>) state.value("memoryAnomalies").orElse(List.of());
        if (!anomalies.isEmpty()) {
            sessionDigest.put("detectedAnomalies", anomalies);
        }
        updates.put("sessionDigest", sessionDigest);

        // 3. Build summaryForNextTurn (enriched with structured data)
        Map<String, Object> nextTurnSummary = new HashMap<>();
        nextTurnSummary.put("taskCompleted", true);
        nextTurnSummary.put("changedFiles", changedFiles);
        nextTurnSummary.put("toolCallCount", toolCallCount);
        nextTurnSummary.put("summaryText", summary.toString());
        if (!archDecisions.isEmpty()) {
            nextTurnSummary.put("architectureDecisions", archDecisions);
        }
        if (!rejectedApproaches.isEmpty()) {
            nextTurnSummary.put("rejectedApproaches", rejectedApproaches);
        }
        updates.put("summaryForNextTurn", nextTurnSummary);

        // 3b. Memory sedimentation: persist approved memory candidates to long-term store
        // Memory candidates from CommitAction are proposed for user approval.
        // Here we auto-approve IMMORTAL/PROTECTED candidates and persist them.
        // (Full approval flow requires UI interaction — this handles the auto-approve path.)
        sedimentMemories(state, changedFiles, goal);

        // 4. Emit finalize events
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PHASE_DONE,
            Map.of("phaseId", "finalize", "summary", summary.toString()));

        Map<String, Object> donePayload = new HashMap<>();
        donePayload.put("reason", "final");
        donePayload.put("goalUnmet", goalUnmet);
        donePayload.put("summary", summary.toString());
        donePayload.put("changedFiles", changedFiles);
        donePayload.put("completedPhases", completedPhases);
        donePayload.put("totalPhases", phases.size());
        state.value(SessionExecutionFacts.STATE_KEY)
                .filter(v -> v instanceof Map<?, ?> m && !m.isEmpty())
                .ifPresent(v -> donePayload.put(SessionExecutionFacts.STATE_KEY, v));
        state.value("summaryForNextTurn")
                .filter(v -> v != null)
                .ifPresent(v -> donePayload.put("summaryForNextTurn", v));
        GraphSseHelper.emitEvent(state, SseEvents.DONE, donePayload);

        log.info(
            "Finalize: task completed. {} phases done, {} files changed, {} tool calls (direct={})",
            completedPhases,
            changedFiles.size(),
            toolCallCount,
            directToolsExecuted.size());
        return updates;
    }

    // ── Memory sedimentation helpers ──

    /**
     * Persist memory candidates and session facts to long-term project memory store.
     * Auto-approves IMMORTAL and PROTECTED candidates; skips VOLATILE ones.
     */
    @SuppressWarnings("unchecked")
    private void sedimentMemories(OverAllState state, List<String> changedFiles, String goal) {
        String projectRootHash = (String) state.value("projectRootHash").orElse("");
        if (projectRootHash.isBlank()) {
            log.debug("FinalizeAction: no projectRootHash, skipping memory sedimentation");
            return;
        }

        List<io.codepilot.core.memory.StructuredMemory> toPersist = new java.util.ArrayList<>();

        // 1. Auto-approve memory candidates from CommitAction
        List<Map<String, Object>> candidates =
                (List<Map<String, Object>>) state.value("memoryCandidates").orElse(List.of());
        for (Map<String, Object> m : candidates) {
            io.codepilot.core.memory.StructuredMemory memory = io.codepilot.core.memory.StructuredMemory.fromMap(m);
            // Only auto-approve IMMORTAL and PROTECTED; VOLATILE/DEGRADABLE need user approval
            if (memory.protection() == io.codepilot.core.memory.ProtectionLevel.IMMORTAL
                    || memory.protection() == io.codepilot.core.memory.ProtectionLevel.PROTECTED) {
                toPersist.add(memory);
            }
        }

        // 2. Create goal memory if meaningful
        if (goal != null && !goal.isBlank()) {
            toPersist.add(io.codepilot.core.memory.StructuredMemory.of(
                    io.codepilot.core.memory.MemoryLayer.LONG_TERM,
                    io.codepilot.core.memory.ProtectionLevel.PROTECTED,
                    io.codepilot.core.memory.MemoryType.DECISION,
                    "Task goal: " + goal,
                    goal,
                    java.util.List.of("session", "goal"),
                    ""));
        }

        // 3. Create changed-file memories
        if (!changedFiles.isEmpty()) {
            toPersist.add(io.codepilot.core.memory.StructuredMemory.of(
                    io.codepilot.core.memory.MemoryLayer.LONG_TERM,
                    io.codepilot.core.memory.ProtectionLevel.PROTECTED,
                    io.codepilot.core.memory.MemoryType.FACT,
                    "Files modified: " + String.join(", ", changedFiles),
                    String.join("\n", changedFiles),
                    java.util.List.of("session", "files"),
                    ""));
        }

        // Persist batch
        if (!toPersist.isEmpty()) {
            try {
                Long saved = projectMemoryStore.saveAll(projectRootHash, toPersist).block();
                log.info("FinalizeAction: sedimented {} memories to long-term store (project={})", saved, projectRootHash);
            } catch (Exception e) {
                log.warn("FinalizeAction: memory sedimentation failed (non-fatal): {}", e.getMessage());
            }
        }
    }

    /**
     * Extract architecture decisions from the execution journal.
     */
    @SuppressWarnings("unchecked")
    private List<String> extractArchitectureDecisions(OverAllState state) {
        Map<String, Object> journal =
                (Map<String, Object>) state.value(GraphExecutionJournal.STATE_KEY).orElse(Map.of());
        List<Map<String, Object>> stages =
                (List<Map<String, Object>>) journal.getOrDefault("stages", List.of());
        List<String> decisions = new java.util.ArrayList<>();
        for (Map<String, Object> stage : stages) {
            String outcome = String.valueOf(stage.getOrDefault("outcome", ""));
            String summary = String.valueOf(stage.getOrDefault("summary", ""));
            if ("ok".equals(outcome) && !summary.isBlank()
                    && (summary.toLowerCase().contains("decided")
                        || summary.toLowerCase().contains("chose")
                        || summary.toLowerCase().contains("architecture")
                        || summary.toLowerCase().contains("implemented"))) {
                decisions.add(summary);
            }
        }
        return decisions;
    }

    /**
     * Extract rejected/failed approaches from the execution journal.
     */
    @SuppressWarnings("unchecked")
    private List<String> extractRejectedApproaches(OverAllState state) {
        Map<String, Object> journal =
                (Map<String, Object>) state.value(GraphExecutionJournal.STATE_KEY).orElse(Map.of());
        List<Map<String, Object>> stages =
                (List<Map<String, Object>>) journal.getOrDefault("stages", List.of());
        List<String> rejected = new java.util.ArrayList<>();
        for (Map<String, Object> stage : stages) {
            String outcome = String.valueOf(stage.getOrDefault("outcome", ""));
            String summary = String.valueOf(stage.getOrDefault("summary", ""));
            if ("blocked".equals(outcome) || "abandon".equals(outcome) || "repair".equals(outcome)) {
                if (!summary.isBlank()) {
                    rejected.add(summary);
                }
            }
        }
        return rejected;
    }
}