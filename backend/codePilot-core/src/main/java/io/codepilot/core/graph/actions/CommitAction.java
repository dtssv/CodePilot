package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphPhaseCheckpointSaver;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.PhaseGoalHelper;
import io.codepilot.core.graph.PhaseOutcomeHelper;
import io.codepilot.core.graph.PhasePlanNormalizer;
import io.codepilot.core.graph.SessionExecutionFacts;
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

    public CommitAction(GraphPhaseCheckpointSaver phaseCheckpointSaver) {
        this.phaseCheckpointSaver = phaseCheckpointSaver;
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
        if (((PhaseOutcomeHelper.rawToolsHadFailure(state)
                        || PhaseOutcomeHelper.gatheredHasFailures(gathered))
                && !stepGoalMet)
            || (stepKind == PhaseGoalHelper.StepKind.RUN && !stepGoalMet)
            || (stepKind == PhaseGoalHelper.StepKind.ANALYZE && !stepGoalMet)
            || (stepKind == PhaseGoalHelper.StepKind.INSPECT && !stepGoalMet)
            || (stepKind == PhaseGoalHelper.StepKind.DISCOVER && !stepGoalMet)) {
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
            return updates;
        }

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

        updates.put("userPlan", syncUserPlanProgress(state, userSteps, stepIdx, hasNext, false));

        if (PhaseGoalHelper.hasSuccessfulSourceRead(gathered)) {
            updates.put("sessionHasSourceReads", true);
        }
        if (Boolean.TRUE.equals(state.value("phaseHasAnalysisOutput").orElse(false))) {
            updates.put("sessionHasAnalysisOutput", true);
        }
        PhaseOutcomeHelper.clearPhaseToolState(updates);
        updates.put("phaseHasAnalysisOutput", false);
        SessionExecutionFacts.putInUpdates(
                updates, SessionExecutionFacts.mergeFromGathered(state, gathered));
        updates.put("gatheredInfo", PhaseGoalHelper.retainSourceReadEntries(gathered));

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
            phaseCheckpointSaver.saveAfterPhase(state, phaseId, "preCheck");
            log.info(
                    "CommitAction: advancing phase {} → {} (step {}/{}, {} phases total)",
                    phaseId,
                    nextPhaseId,
                    stepIdx + 2,
                    userSteps.size(),
                    phases.size());
        } else {
            phaseCheckpointSaver.saveAfterPhase(state, phaseId, "finalize");
            log.info(
                    "CommitAction: last phase {} done (step {}/{}, {} phases)",
                    phaseId,
                    stepIdx + 1,
                    userSteps.size(),
                    phases.size());
        }

        UserPlanProgressHelper.emitPhaseCompleted(state, phaseId, hasNext);
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
            return "retryGenerate";
        }
        Boolean hasNext = (Boolean) state.value("hasNextPhase").orElse(false);
        return hasNext ? "preCheck" : "finalize";
    }
}
