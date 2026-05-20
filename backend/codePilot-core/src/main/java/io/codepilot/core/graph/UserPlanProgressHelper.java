package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.sse.SseEvents;
import java.util.List;
import java.util.Map;

/** Maps execution-phase progress to user-facing plan step IDs (s1, s2, …). */
public final class UserPlanProgressHelper {

  private UserPlanProgressHelper() {}

  public static void emitForCurrentPhase(OverAllState state, String status) {
    String phaseId = (String) state.value("phaseCursor").orElse("");
    int phaseIdx = phaseIndex(state, phaseId);
    emitByIndex(state, phaseIdx, status, null);
  }

  public static void emitByIndex(OverAllState state, int stepIndex, String status, String message) {
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> steps =
        (List<Map<String, Object>>)
            ((Map<String, Object>) state.value("userPlan").orElse(Map.of()))
                .getOrDefault("steps", List.of());
    String stepId = resolveStepId(steps, stepIndex);
    var payload = new java.util.HashMap<String, Object>();
    payload.put("stepId", stepId);
    payload.put("stepIndex", stepIndex);
    payload.put("status", status);
    if (message != null && !message.isBlank()) {
      payload.put("message", message);
    }
    GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS, payload);
  }

  public static void emitPhaseCompleted(OverAllState state, String phaseId, boolean hasNextPhase) {
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> steps =
        (List<Map<String, Object>>)
            ((Map<String, Object>) state.value("userPlan").orElse(Map.of()))
                .getOrDefault("steps", List.of());

    int stepIdx = stepIndexForPhase(state, phaseId);

    emitByIndex(state, stepIdx, "completed", "Phase completed successfully");

    if (hasNextPhase && stepIdx + 1 < steps.size()) {
      emitByIndex(state, stepIdx + 1, "in_progress", "Starting next plan step");
    }
  }

  /** User-plan step index for a phase (prefers {@code userStepIndex} on the phase map). */
  public static int stepIndexForPhase(OverAllState state, String phaseId) {
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> phases =
        (List<Map<String, Object>>) state.value("phases").orElse(List.of());
    for (Map<String, Object> phase : phases) {
      if (phaseId.equals(phase.get("id"))) {
        Object idx = phase.get("userStepIndex");
        if (idx instanceof Number n) {
          return n.intValue();
        }
        break;
      }
    }
    return phaseIndex(state, phaseId);
  }

  /** Resolve user-plan step index for the active execution phase. */
  public static int currentStepIndex(OverAllState state) {
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> phases =
        (List<Map<String, Object>>) state.value("phases").orElse(List.of());
    String phaseId = (String) state.value("phaseCursor").orElse("");
    return stepIndexForPhase(state, phaseId);
  }

  private static int phaseIndex(OverAllState state, String phaseId) {
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> phases =
        (List<Map<String, Object>>) state.value("phases").orElse(List.of());
    for (int i = 0; i < phases.size(); i++) {
      if (phaseId.equals(phases.get(i).get("id"))) {
        return i;
      }
    }
    return 0;
  }

  private static String resolveStepId(List<Map<String, Object>> steps, int index) {
    if (steps.isEmpty()) {
      return "s" + (index + 1);
    }
    if (index >= 0 && index < steps.size()) {
      Object id = steps.get(index).get("id");
      if (id != null && !id.toString().isBlank()) {
        return id.toString();
      }
    }
    return "s" + (index + 1);
  }
}
