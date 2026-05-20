package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.Map;

/** Tracks whether direct/gather tools failed in the current plan step (phase). */
public final class PhaseOutcomeHelper {

  private PhaseOutcomeHelper() {}

  public static boolean hasToolFailures(OverAllState state) {
    if (!rawToolsHadFailure(state)) {
      return false;
    }
    // Earlier tool failed but a later alternative satisfied this step (e.g. g++ after cmake).
    if (PhaseGoalHelper.currentStepGoalSatisfied(state)) {
      return false;
    }
    return true;
  }

  /** Whether any tool failed in this phase before goal-override logic. */
  public static boolean rawToolsHadFailure(OverAllState state) {
    return Boolean.TRUE.equals(state.value("phaseToolsHadFailure").orElse(false));
  }

  @SuppressWarnings("unchecked")
  public static boolean gatheredHasFailures(Map<String, Object> gathered) {
    if (gathered == null || gathered.isEmpty()) {
      return false;
    }
    for (Object value : gathered.values()) {
      if (value instanceof Map<?, ?> raw) {
        @SuppressWarnings("unchecked")
        Map<String, Object> entry = (Map<String, Object>) raw;
        if (!GatheredInfoFormatter.entrySucceeded(entry)) {
          return true;
        }
      }
    }
    return false;
  }

  /** Merge tool results into state updates; sets {@code phaseToolsHadFailure} when any entry failed. */
  public static void recordGatheredOutcome(
      OverAllState state, Map<String, Object> gathered, Map<String, Object> updates) {
    updates.put("gatheredInfo", gathered);
    SessionExecutionFacts.putInUpdates(
        updates, SessionExecutionFacts.mergeFromGathered(state, gathered));
    PhaseGoalHelper.recordSessionMilestones(updates, gathered);
    if (goalSatisfiedWithGathered(state, gathered)) {
      updates.put("phaseToolsHadFailure", false);
    } else if (gatheredHasFailures(gathered) || ToolApproachTracker.gatheredHasUnsatisfactory(gathered)) {
      updates.put("phaseToolsHadFailure", true);
    } else if (Boolean.TRUE.equals(state.value("phaseToolsHadFailure").orElse(false))) {
      updates.put("phaseToolsHadFailure", true);
    }
  }

  static boolean goalSatisfiedWithGathered(
      OverAllState state, Map<String, Object> gathered) {
    if (gathered == null || gathered.isEmpty()) {
      return false;
    }
    PhaseGoalHelper.StepKind kind = PhaseGoalHelper.inferStepKind(state);
    return switch (kind) {
      case COMPILE -> PhaseGoalHelper.hasSuccessfulCompile(gathered);
      case RUN -> PhaseGoalHelper.hasSuccessfulRun(gathered);
      case ANALYZE -> PhaseGoalHelper.analyzeGoalMet(state, gathered);
      case INSPECT -> SessionExecutionFacts.inspectGoalMet(state, gathered);
      case PREPARE ->
          gatheredHasSuccessfulPrepare(gathered) || PhaseGoalHelper.hasSuccessfulCompile(gathered);
      case DISCOVER -> PhaseGoalHelper.gatheredHasSuccessfulList(gathered);
      case SYNTHESIZE -> PhaseGoalHelper.hasSuccessfulRun(gathered) || PhaseGoalHelper.hasSuccessfulCompile(gathered);
      case GENERIC ->
          PhaseGoalHelper.hasSuccessfulCompile(gathered) || PhaseGoalHelper.hasSuccessfulRun(gathered);
    };
  }

  @SuppressWarnings("unchecked")
  private static boolean gatheredHasSuccessfulPrepare(Map<String, Object> gathered) {
    for (Object value : gathered.values()) {
      if (value instanceof Map<?, ?> entry
          && GatheredInfoFormatter.entrySucceeded((Map<String, Object>) entry)
          && "fs.list".equals(String.valueOf(((Map<String, Object>) entry).get("kind")))) {
        return true;
      }
    }
    return false;
  }

  public static void clearPhaseToolState(Map<String, Object> updates) {
    updates.put("phaseToolsHadFailure", false);
    updates.put("phaseFailureRetries", 0);
    updates.put("phaseCommitBlocked", false);
    updates.put("directToolRound", 0);
    updates.put("phaseGeneratePasses", 0);
    ToolApproachTracker.clearInPhase(updates);
  }

  public static String failureDirective() {
    return "\n\n[MANDATORY — CURRENT STEP NOT DONE]\n"
        + "One or more tools failed in this step (see [FAILED] lines in [GATHERED CONTEXT]).\n"
        + "Do NOT use textOutput to mark this step complete. Do NOT assume build/run succeeded.\n"
        + "Run the correct tool to fix or complete this step, or report the failure honestly.\n";
  }
}
