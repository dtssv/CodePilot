package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Aligns graph {@code phases[]} with {@code userPlan.steps} so each checklist item runs as its own
 * generate→apply→verify cycle.
 */
public final class PhasePlanNormalizer {

  private static final Logger log = LoggerFactory.getLogger(PhasePlanNormalizer.class);

  private PhasePlanNormalizer() {}

  public record NormalizedPlan(List<Map<String, Object>> steps, List<Map<String, Object>> phases) {}

  @SuppressWarnings("unchecked")
  public static List<Map<String, Object>> normalize(
      List<Map<String, Object>> userSteps, List<Map<String, Object>> phases) {
    return normalizePlan(userSteps, phases).phases();
  }

  /** Align phases with user steps, then merge duplicate deliverable-write steps by intent. */
  @SuppressWarnings("unchecked")
  public static NormalizedPlan normalizePlan(
      List<Map<String, Object>> userSteps, List<Map<String, Object>> phases) {
    List<Map<String, Object>> steps =
        userSteps == null ? List.of() : new ArrayList<>(userSteps);
    List<Map<String, Object>> aligned = alignPhases(steps, phases);
    return consolidateDeliverableSteps(steps, aligned);
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> alignPhases(
      List<Map<String, Object>> userSteps, List<Map<String, Object>> phases) {
    if (userSteps.size() <= 1) {
      return phases == null ? List.of() : phases;
    }
    if (phases == null || phases.isEmpty()) {
      return expandFromSteps(userSteps, defaultPhaseTemplate());
    }

    if (phases.size() == userSteps.size()) {
      return linkPhasesToSteps(phases, userSteps);
    }

    if (phases.size() == 1) {
      log.info(
          "Expanding 1 execution phase into {} phases (one per user plan step)",
          userSteps.size());
      return expandFromSinglePhase(phases.get(0), userSteps);
    }

    if (phases.size() > userSteps.size()) {
      log.info(
          "Trimming {} phases to {} to match user plan steps",
          phases.size(),
          userSteps.size());
      return linkPhasesToSteps(phases.subList(0, userSteps.size()), userSteps);
    }

    log.info(
        "Expanding {} phases to {} to match user plan steps",
        phases.size(),
        userSteps.size());
    return expandFromSteps(userSteps, phases.get(0));
  }

  /**
   * Collapse multiple synthesize / markdown-write steps into one final deliverable step.
   */
  static NormalizedPlan consolidateDeliverableSteps(
      List<Map<String, Object>> steps, List<Map<String, Object>> phases) {
    if (steps.size() <= 1 || phases.size() != steps.size()) {
      return new NormalizedPlan(steps, phases);
    }

    List<Integer> writeIdx = new ArrayList<>();
    for (int i = 0; i < steps.size(); i++) {
      if (isDeliverableWriteStep(steps.get(i))) {
        writeIdx.add(i);
      }
    }
    if (writeIdx.size() <= 1) {
      return new NormalizedPlan(steps, phases);
    }

    int keep = writeIdx.get(writeIdx.size() - 1);
    log.info(
        "Merging {} deliverable-write steps into step index {} (1-based step {})",
        writeIdx.size(),
        keep,
        keep + 1);

    List<Map<String, Object>> newSteps = new ArrayList<>();
    List<Map<String, Object>> newPhases = new ArrayList<>();
    for (int i = 0; i < steps.size(); i++) {
      if (writeIdx.contains(i) && i != keep) {
        continue;
      }
      Map<String, Object> step = new LinkedHashMap<>(steps.get(i));
      Map<String, Object> phase = new LinkedHashMap<>(phases.get(i));
      if (i == keep) {
        step.put("intent", PhaseGoalHelper.INTENT_SYNTHESIZE);
        phase.put("intent", PhaseGoalHelper.INTENT_SYNTHESIZE);
      }
      newSteps.add(step);
      newPhases.add(phase);
    }

    for (int i = 0; i < newPhases.size(); i++) {
      Map<String, Object> phase = new LinkedHashMap<>(newPhases.get(i));
      phase.put("id", "p" + (i + 1));
      attachStep(phase, i, newSteps.get(i));
      newPhases.set(i, phase);
    }

    return new NormalizedPlan(newSteps, newPhases);
  }

  private static boolean isDeliverableWriteStep(Map<String, Object> step) {
    return PhaseGoalHelper.isDeliverableWriteIntent(String.valueOf(step.getOrDefault("intent", "")));
  }

  private static Map<String, Object> defaultPhaseTemplate() {
    return Map.of(
        "intent", "code-change",
        "entry", List.of(),
        "exit", List.of(),
        "budget", Map.of("attempts", 3));
  }

  private static List<Map<String, Object>> expandFromSinglePhase(
      Map<String, Object> template, List<Map<String, Object>> userSteps) {
    return expandFromSteps(userSteps, template);
  }

  private static List<Map<String, Object>> expandFromSteps(
      List<Map<String, Object>> userSteps, Map<String, Object> template) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (int i = 0; i < userSteps.size(); i++) {
      out.add(buildPhaseForStep(i, userSteps.get(i), template));
    }
    return out;
  }

  private static List<Map<String, Object>> linkPhasesToSteps(
      List<Map<String, Object>> phases, List<Map<String, Object>> userSteps) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (int i = 0; i < phases.size(); i++) {
      Map<String, Object> phase = new LinkedHashMap<>(phases.get(i));
      phase.put("id", "p" + (i + 1));
      if (i < userSteps.size()) {
        attachStep(phase, i, userSteps.get(i));
      }
      out.add(phase);
    }
    return out;
  }

  private static Map<String, Object> buildPhaseForStep(
      int index, Map<String, Object> step, Map<String, Object> template) {
    Map<String, Object> phase = new LinkedHashMap<>();
    phase.put("id", "p" + (index + 1));
    Object title = step.get("title");
    phase.put("title", title != null && !title.toString().isBlank() ? title : "Step " + (index + 1));
    Object stepIntent = step.get("intent");
    if (stepIntent != null && !stepIntent.toString().isBlank()) {
      phase.put("intent", stepIntent.toString());
    } else {
      phase.put("intent", template.getOrDefault("intent", "code-change"));
    }
    phase.put("entry", template.getOrDefault("entry", List.of()));
    phase.put("exit", template.getOrDefault("exit", List.of()));
    phase.put("budget", template.getOrDefault("budget", Map.of("attempts", 3)));
    attachStep(phase, index, step);
    return phase;
  }

  private static void attachStep(Map<String, Object> phase, int index, Map<String, Object> step) {
    phase.put("userStepIndex", index);
    Object stepId = step.get("id");
    if (stepId != null && !stepId.toString().isBlank()) {
      phase.put("userStepId", stepId.toString());
    } else {
      phase.put("userStepId", "s" + (index + 1));
    }
    Object desc = step.get("description");
    if (desc != null && !desc.toString().isBlank()) {
      phase.put("stepDescription", desc.toString());
    }
  }
}
