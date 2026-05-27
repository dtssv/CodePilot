package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphExecutionJournal;
import io.codepilot.core.graph.GraphPhaseCheckpointSaver;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.PhaseFailureRepairHelper;
import io.codepilot.core.graph.PhaseGoalHelper;
import io.codepilot.core.graph.PhaseOutcomeHelper;
import io.codepilot.core.graph.PhasePlanNormalizer;
import io.codepilot.core.graph.SessionExecutionFacts;
import io.codepilot.core.graph.ToolApproachTracker;
import io.codepilot.core.graph.UserPlanProgressHelper;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import java.util.*;

/**
 * Commit node: marks current phase done, advances to next phase, and
 * emits user_plan_progress to update the user-facing plan step status.
 */
@Component
public class CommitAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(CommitAction.class);

    private final GraphPhaseCheckpointSaver phaseCheckpointSaver;
    private final io.codepilot.core.graph.PhaseAwareMemoryLoader phaseAwareMemoryLoader;
    private final io.codepilot.core.graph.GraphStateArchiver stateArchiver;
    private final io.codepilot.core.graph.GraphMemoryDistillHelper memoryDistillHelper;
    private final io.codepilot.core.graph.GraphMemoryCompactHelper memoryCompactHelper;
    private final io.codepilot.core.run.GraphEngineProperties graphProperties;

    public CommitAction(GraphPhaseCheckpointSaver phaseCheckpointSaver,
                        io.codepilot.core.graph.PhaseAwareMemoryLoader phaseAwareMemoryLoader,
                        io.codepilot.core.graph.GraphStateArchiver stateArchiver,
                        io.codepilot.core.graph.GraphMemoryDistillHelper memoryDistillHelper,
                        io.codepilot.core.graph.GraphMemoryCompactHelper memoryCompactHelper,
                        io.codepilot.core.run.GraphEngineProperties graphProperties) {
        this.phaseCheckpointSaver = phaseCheckpointSaver;
        this.phaseAwareMemoryLoader = phaseAwareMemoryLoader;
        this.stateArchiver = stateArchiver;
        this.memoryDistillHelper = memoryDistillHelper;
        this.memoryCompactHelper = memoryCompactHelper;
        this.graphProperties = graphProperties;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "commit");
        String phaseId = (String) state.value("phaseCursor").orElse("");

        @SuppressWarnings("unchecked")
        Map<String, Object> gathered =
                (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
        int stepIdx = UserPlanProgressHelper.stepIndexForPhase(state, phaseId);

        PhaseGoalHelper.StepKind stepKind = PhaseGoalHelper.inferStepKind(state);
        boolean stepGoalMet = PhaseGoalHelper.currentStepGoalSatisfied(state);
        // When verify succeeded (no compile errors, no test failures), there are no
        // actionable tool failures left — routing to repair would be pointless and can
        // cause a commit→repair→commit infinite loop. Only consider tool failures when
        // verify has not confirmed success.
        String verifyResult = (String) state.value("verifyResult").orElse("");
        boolean verifySucceeded = "success".equals(verifyResult);
        // When repair returned partialCommit (budget exhausted but some patches applied),
        // we must NOT route back to repair — that would cause an infinite loop.
        // Clear the stale failure state so the commit can proceed.
        String repairResult = (String) state.value("repairResult").orElse("");
        boolean partialCommit = "partialCommit".equals(repairResult);
        boolean toolFailures = !verifySucceeded && !partialCommit
                && (PhaseOutcomeHelper.rawToolsHadFailure(state)
                        || PhaseOutcomeHelper.gatheredHasFailures(gathered));

        if (!stepGoalMet && PhaseFailureRepairHelper.shouldAbandonPhase(state)) {
            int attempts = PhaseFailureRepairHelper.failureAttempts(state);
            PhaseFailureRepairHelper.clearPhaseAttemptCounters(updates);
            updates.put("overallGoalUnmet", true);
            GraphExecutionJournal.recordPhaseBoundary(
                    state, updates, phaseId, "commit", "abandon", gathered);
            log.warn(
                    "CommitAction: abandoning phase {} after {} failed attempts (kind={}, step {})",
                    phaseId,
                    attempts,
                    stepKind,
                    stepIdx + 1);
        } else if (partialCommit) {
            // Repair budget exhausted with partial results — clear stale failure state
            // and advance to the next phase instead of looping back to repair.
            log.info("CommitAction: partialCommit for phase {} — clearing failure state and advancing", phaseId);
            PhaseFailureRepairHelper.clearPhaseAttemptCounters(updates);
            updates.put("verifyResult", "success");
            updates.put("phaseToolsHadFailure", false);
        } else if (!stepGoalMet && toolFailures) {
            GraphExecutionJournal.recordPhaseBoundary(
                    state, updates, phaseId, "commit", "repair", gathered);
            PhaseFailureRepairHelper.prepareRepairFromFailures(state, updates);
            log.warn(
                    "CommitAction: routing phase {} to repair (kind={}, attempt={}/{})",
                    phaseId,
                    stepKind,
                    updates.get("phaseFailureRetries"),
                    PhaseFailureRepairHelper.MAX_PHASE_FAILURE_ATTEMPTS);
            return updates;
        } else if (!stepGoalMet && verifySucceeded
                && (stepKind == PhaseGoalHelper.StepKind.COMPILE
                        || stepKind == PhaseGoalHelper.StepKind.RUN
                        || stepKind == PhaseGoalHelper.StepKind.VERIFY)) {
            // Verify passed (0 IDE diagnostics) but the RUN/COMPILE/VERIFY step goal is still unmet:
            // no successful shell.exec run/compile in gatheredInfo. The patches may have fixed
            // compilation errors, but the test was never re-executed to validate the fix.
            // Route back to generate so the LLM re-runs the test command.
            int generatePasses = (int) state.value("phaseGeneratePasses").orElse(0);
            if (generatePasses >= PhaseGoalHelper.STUCK_COMPILE_RUN_PASS_THRESHOLD) {
                // Safety valve: after enough retries, stop looping and advance with overallGoalUnmet
                log.warn(
                        "CommitAction: RUN/COMPILE step goal still unmet after {} generate passes "
                                + "(kind={}) — advancing with overallGoalUnmet",
                        generatePasses,
                        stepKind);
                updates.put("overallGoalUnmet", true);
                GraphExecutionJournal.recordPhaseBoundary(
                        state, updates, phaseId, "commit", "goal_unmet_advance", gathered);
            } else {
                log.info(
                        "CommitAction: verify succeeded but {} step goal not met — "
                                + "routing to retryGenerate (pass {}/{})",
                        stepKind,
                        generatePasses,
                        PhaseGoalHelper.STUCK_COMPILE_RUN_PASS_THRESHOLD);
                updates.put("phaseCommitBlocked", true);
                updates.put("hasNextPhase", false);
                GraphExecutionJournal.recordPhaseBoundary(
                        state, updates, phaseId, "commit", "retry_generate", gathered);
                return updates;
            }
        } else if (!stepGoalMet
                && !verifySucceeded
                && ((stepKind == PhaseGoalHelper.StepKind.RUN && !stepGoalMet)
                        || (stepKind == PhaseGoalHelper.StepKind.ANALYZE && !stepGoalMet)
                        || (stepKind == PhaseGoalHelper.StepKind.INSPECT && !stepGoalMet)
                        || (stepKind == PhaseGoalHelper.StepKind.DISCOVER && !stepGoalMet)
                        || (stepKind == PhaseGoalHelper.StepKind.SYNTHESIZE && !stepGoalMet))) {
            log.warn(
                    "CommitAction: blocking phase {} commit — step goal not met (kind={}, step {})",
                    phaseId,
                    stepKind,
                    stepIdx + 1);
            updates.put("phaseCommitBlocked", true);
            updates.put("hasNextPhase", false);
            String msg =
                    "Tools failed in this step — fix errors in [GATHERED CONTEXT] before continuing.";
            UserPlanProgressHelper.emitByIndex(state, stepIdx, "failed", msg);
            updates.put(
                    "userPlan",
                    syncUserPlanProgress(
                            state,
                            userSteps(state),
                            stepIdx,
                            false,
                            true));
            GraphSseHelper.emitEvent(
                    state,
                    SseEvents.GRAPH_PHASE_DONE,
                    Map.of("phaseId", phaseId, "summary", "Phase blocked: tool failures", "ok", false));
            GraphExecutionJournal.recordPhaseBoundary(
                    state, updates, phaseId, "commit", "blocked", gathered);
            return updates;
        }

        GraphExecutionJournal.recordPhaseBoundary(
                state, updates, phaseId, "commit", "ok", gathered);

        // Emit graph_phase_done (execution layer)
        GraphSseHelper.emitEvent(
                state,
                SseEvents.GRAPH_PHASE_DONE,
                Map.of("phaseId", phaseId, "summary", "Phase " + phaseId + " completed", "ok", true));

        List<Map<String, Object>> userSteps = userSteps(state);
        var phases = new ArrayList<>((List<Map<String, Object>>) state.value("phases").orElse(List.of()));
        if (userSteps.size() > 1) {
            phases = new ArrayList<>(PhasePlanNormalizer.normalize(userSteps, phases));
            updates.put("phases", phases);
        }

        int currentIdx = -1;
        for (int i = 0; i < phases.size(); i++) {
            if (phaseId.equals(phases.get(i).get("id"))) {
                currentIdx = i;
                break;
            }
        }
        boolean hasNext = currentIdx >= 0 && currentIdx < phases.size() - 1;
        updates.put("hasNextPhase", hasNext);
        updates.put("phaseCommitBlocked", false);

        @SuppressWarnings("unchecked")
        List<String> completedPhases =
                new ArrayList<>((List<String>) state.value("completedPhases").orElse(List.of()));
        if (!completedPhases.contains(phaseId)) {
            completedPhases.add(phaseId);
        }
        updates.put("completedPhases", List.copyOf(completedPhases));

        // ── For internal micro-phases, skip userPlan progress update ──
        // Internal phases are user-invisible sub-steps; only the macro-phase progress
        // matters to the user. This prevents the UI showing 25 tiny sub-steps
        // when the user expects "Entity generation" as one step.
        @SuppressWarnings("unchecked")
        boolean isInternalPhase = Boolean.TRUE.equals(
                ((List<Map<String, Object>>) state.value("phases").orElse(List.of()))
                        .stream()
                        .filter(p -> phaseId.equals(p.get("id")))
                        .findFirst()
                        .orElse(Map.of())
                        .getOrDefault("internalPhase", false));

        if (!isInternalPhase) {
            updates.put("userPlan", syncUserPlanProgress(state, userSteps, stepIdx, hasNext, false));
        }

        if (PhaseGoalHelper.hasSuccessfulSourceRead(gathered)) {
            updates.put("sessionHasSourceReads", true);
        }
        if (Boolean.TRUE.equals(state.value("phaseHasAnalysisOutput").orElse(false))) {
            updates.put("sessionHasAnalysisOutput", true);
        }
        PhaseOutcomeHelper.clearPhaseToolState(updates);
        GraphExecutionJournal.clearEphemeralNodeState(updates);
        updates.put("phaseHasAnalysisOutput", false);
        SessionExecutionFacts.putInUpdates(
                updates, SessionExecutionFacts.mergeFromGathered(state, gathered));
        updates.put("gatheredInfo", PhaseGoalHelper.retainSourceReadEntries(gathered, graphProperties.getGatheredInfoCharsBudget()));
        updates.put("gatherCount", 0);
        updates.put("gatherExhausted", false);

        // ── Memory compression: compact gatheredInfo into memory candidates ──
        // At phase boundaries, extract structured memory candidates from gathered context
        // so that key information survives across phases even when gatheredInfo is trimmed.
        var memoryCandidates = memoryDistillHelper.distillCandidates(state, gathered, phaseId);
        if (!memoryCandidates.isEmpty()) {
            List<Map<String, Object>> mergedCandidates = mergeMemoryCandidates(state, memoryCandidates);
            updates.put("memoryCandidates", mergedCandidates);
            // Emit memory.candidate SSE for UI approval
            var candidatePayload = new java.util.HashMap<String, Object>();
            candidatePayload.put("candidates", memoryCandidates.stream()
                    .map(io.codepilot.core.memory.StructuredMemory::toMap).toList());
            candidatePayload.put("phaseId", phaseId);
            io.codepilot.core.graph.GraphSseHelper.emitEvent(state,
                    io.codepilot.core.sse.SseEvents.MEMORY_CANDIDATE,
                    candidatePayload);
            log.info("CommitAction: extracted {} memory candidates for phase {}", memoryCandidates.size(), phaseId);
        }

        if (!hasNext && !PhaseGoalHelper.overallCompileRunGoalMet(state)) {
            updates.put("overallGoalUnmet", true);
            log.warn(
                    "CommitAction: last phase done but overall compile/run goal not met (compile={}, run={})",
                    state.value("sessionHadSuccessfulCompile").orElse(false),
                    state.value("sessionHadSuccessfulRun").orElse(false));
        }

        if (hasNext) {
            String nextPhaseId = (String) phases.get(currentIdx + 1).get("id");
            updates.put("phaseCursor", nextPhaseId);
            ToolApproachTracker.clearInPhase(updates);
            updates.put("approachEscalationDone", false);
            updates.put("overallGoalUnmet", false);
            // Clear per-phase shell history so the LLM starts fresh in the next phase
            SessionExecutionFacts.clearPhaseHistory(updates, state);
            phaseCheckpointSaver.saveAfterPhase(state, phaseId, "preCheck", updates);

            // ── Phase-aware memory loading ──
            // Dynamically load memories relevant to the next phase's tags/intent,
            // ensuring super-complex tasks get only the context they need per phase.
            phaseAwareMemoryLoader.loadForNextPhase(state, updates, nextPhaseId);

            // ── State archiving ──
            // When completedPhases exceeds the threshold, archive older phase details
            // to Redis to prevent unbounded state growth during super-complex tasks.
            if (stateArchiver.shouldArchive(state)) {
                stateArchiver.archiveOldPhases(state, updates);
            }

            // ── Memory compaction ──
            // When memoryNeedsCompact is true, compress DEGRADABLE/VOLATILE activeMemories
            // into a single summary. This reduces context pressure for super-complex tasks.
            // IMMORTAL/PROTECTED memories are never compressed — key information is preserved.
            // The compression result is emitted to the user via SSE with a special marker
            // so that future session recovery can restore from compacted context instead of
            // replaying the full conversation history.
            if (Boolean.TRUE.equals(state.value("memoryNeedsCompact").orElse(false))) {
                compactActiveMemoriesWithLlm(state, updates, phaseId);
            }

            log.info(
                    "CommitAction: advancing phase {} → {} (step {}/{}, {} phases total)",
                    phaseId,
                    nextPhaseId,
                    stepIdx + 2,
                    userSteps.size(),
                    phases.size());
        } else {
            phaseCheckpointSaver.saveAfterPhase(state, phaseId, "summarize", updates);
            log.info(
                    "CommitAction: last phase {} done (step {}/{}, {} phases)",
                    phaseId,
                    stepIdx + 1,
                    userSteps.size(),
                    phases.size());
        }

        if (!isInternalPhase) {
            UserPlanProgressHelper.emitPhaseCompleted(state, phaseId, hasNext);
        }
        return updates;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> userSteps(OverAllState state) {
        return (List<Map<String, Object>>)
                ((Map<String, Object>) state.value("userPlan").orElse(Map.of()))
                        .getOrDefault("steps", List.of());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> syncUserPlanProgress(
            OverAllState state,
            List<Map<String, Object>> userSteps,
            int stepIdx,
            boolean hasNext,
            boolean markCurrentFailed) {
        Map<String, Object> userPlan =
                new LinkedHashMap<>((Map<String, Object>) state.value("userPlan").orElse(Map.of()));
        List<Map<String, Object>> synced = new ArrayList<>();
        for (int i = 0; i < userSteps.size(); i++) {
            Map<String, Object> step = new LinkedHashMap<>(userSteps.get(i));
            if (i < stepIdx) {
                step.put("status", "completed");
            } else if (i == stepIdx) {
                step.put("status", markCurrentFailed ? "failed" : "completed");
            } else if (hasNext && i == stepIdx + 1) {
                step.put("status", "in_progress");
            } else if (!step.containsKey("status")) {
                step.put("status", "pending");
            }
            synced.add(step);
        }
        userPlan.put("steps", synced);
        userPlan.put("status", markCurrentFailed ? "failed" : (hasNext ? "in_progress" : "completed"));
        return userPlan;
    }

    public String routeAfterCommit(OverAllState state) {
        if (Boolean.TRUE.equals(state.value("phaseCommitBlocked").orElse(false))) {
            // When the RUN/COMPILE step goal is unmet but verify succeeded (0 IDE diagnostics),
            // route back to generate so the LLM re-runs the test, instead of routing to repair
            // which would be pointless (verify already confirmed no compile errors).
            String verifyResult = (String) state.value("verifyResult").orElse("");
            boolean verifySucceeded = "success".equals(verifyResult);
            PhaseGoalHelper.StepKind stepKind = PhaseGoalHelper.inferStepKind(state);
            boolean stepGoalMet = PhaseGoalHelper.currentStepGoalSatisfied(state);
            if (verifySucceeded && !stepGoalMet
                    && (stepKind == PhaseGoalHelper.StepKind.COMPILE
                            || stepKind == PhaseGoalHelper.StepKind.RUN
                            || stepKind == PhaseGoalHelper.StepKind.VERIFY)) {
                return "retryGenerate";
            }
            return "repair";
        }
        Boolean hasNext = (Boolean) state.value("hasNextPhase").orElse(false);
        if (hasNext) {
            return "preCheck";
        }
        // ── Hierarchical planning: check if there are more macro-phases to expand ──
        boolean hierarchicalPlan = Boolean.TRUE.equals(state.value("hierarchicalPlan").orElse(false));
        if (hierarchicalPlan) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> macroPhases =
                    (List<Map<String, Object>>) state.value("macroPhases").orElse(List.of());
            int macroPhaseCursor = (int) state.value("macroPhaseCursor").orElse(0);
            if (macroPhaseCursor + 1 < macroPhases.size()) {
                // All micro-phases of current macro-phase are done — emit userPlan progress
                // to mark the current macro-phase step as completed and the next as in_progress.
                // This ensures the UI reflects macro-phase transitions even though internal
                // micro-phases were invisible to the user.
                List<Map<String, Object>> userSteps = userSteps(state);
                if (!userSteps.isEmpty()) {
                    int completedStepIdx = Math.min(macroPhaseCursor, userSteps.size() - 1);
                    UserPlanProgressHelper.emitByIndex(state, completedStepIdx, "completed",
                            "Macro-phase completed successfully");
                    if (completedStepIdx + 1 < userSteps.size()) {
                        UserPlanProgressHelper.emitByIndex(state, completedStepIdx + 1, "in_progress",
                                "Starting next macro-phase");
                    }
                }

                log.info("CommitAction: all micro-phases done, routing to dynamicPlanExpand " +
                        "for macro-phase {}/{}", macroPhaseCursor + 2, macroPhases.size());
                return "dynamicPlanExpand";
            }
        }
        return "summarize";
    }

    // ── Memory compaction ──────────────────────────────────────

    /**
     * Compress DEGRADABLE/VOLATILE activeMemories into a single summary memory.
     * IMMORTAL/PROTECTED memories are never compressed.
     *
     * <p>The compression result is:
     * <ul>
     *   <li>Stored in state as {@code compactedSummary} for session recovery</li>
     *   <li>Emitted via SSE {@code memory.compacted} event with a special marker
     *       {@code __COMPACTED__} so the client/frontend can distinguish it from
     *       regular SSE events. When loading a historical session, the presence of
     *       this marker in the session digest signals that the session should be
     *       restored from the compacted context rather than replaying the full
     *       conversation history.</li>
     * </ul>
     */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> mergeMemoryCandidates(
            OverAllState state, List<io.codepilot.core.memory.StructuredMemory> newOnes) {
        List<Map<String, Object>> existing =
                (List<Map<String, Object>>) state.value("memoryCandidates").orElse(List.of());
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Map<String, Object> m : existing) {
            byId.put(String.valueOf(m.getOrDefault("id", UUID.randomUUID().toString())), m);
        }
        for (io.codepilot.core.memory.StructuredMemory m : newOnes) {
            byId.put(m.id(), m.toMap());
        }
        return List.copyOf(byId.values());
    }

    @SuppressWarnings("unchecked")
    private void compactActiveMemoriesWithLlm(OverAllState state, Map<String, Object> updates, String phaseId) {
        List<Map<String, Object>> activeMemoriesMap =
                (List<Map<String, Object>>) state.value("activeMemories").orElse(List.of());
        if (activeMemoriesMap.isEmpty()) {
            return;
        }

        List<io.codepilot.core.memory.StructuredMemory> allMemories =
                activeMemoriesMap.stream()
                        .map(io.codepilot.core.memory.StructuredMemory::fromMap)
                        .toList();

        var result = memoryCompactHelper.compact(state, phaseId, allMemories);
        if (result.compactedSummary() == null) {
            return;
        }

        updates.put(
                "activeMemories",
                result.activeMemories().stream()
                        .map(io.codepilot.core.memory.StructuredMemory::toMap)
                        .toList());
        updates.put("compactedSummary", result.compactedSummary());
        updates.put("memoryNeedsCompact", false);

        var compactedPayload = new java.util.HashMap<String, Object>();
        compactedPayload.put("__COMPACTED__", true);
        compactedPayload.put("phaseId", phaseId);
        compactedPayload.put("summary", result.compactedSummary());
        io.codepilot.core.graph.GraphSseHelper.emitEvent(
                state, io.codepilot.core.sse.SseEvents.MEMORY_COMPACTED, compactedPayload);

        log.info("CommitAction: memory compacted for phase {} ({} active memories)",
                phaseId, result.activeMemories().size());
    }
}
