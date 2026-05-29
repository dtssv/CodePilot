package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Normalizes planner output: links phases to user steps, fills defaults, optionally merges
 * duplicate synthesize deliverable steps. Does <b>not</b> expand or trim phase count when the
 * planner already returned multiple phases — execution structure is model-owned.
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

    // Legacy fallback: planner returned a single template phase for a multi-step user plan.
    // ★ Log a warning because this indicates the LLM ignored the [CRITICAL] prompt directive.
    // The expanded phases will inherit the single template's intent — they lack per-step
    // intent/tags/memoryHints, which degrades phase-aware memory loading quality.
    if (phases.size() == 1 && userSteps.size() > 1) {
      log.warn(
          "Planner returned 1 phase for {} user steps — LLM ignored [CRITICAL] directive. "
          + "Expanding from step template (fallback). Per-phase tags/intent may be missing.",
          userSteps.size());
      return expandFromSinglePhase(phases.get(0), userSteps);
    }

    if (phases.size() > userSteps.size()) {
      log.info(
          "Keeping {} planner phases (user plan has {} steps) — no engineering trim",
          phases.size(),
          userSteps.size());
      return linkPhasesToSteps(phases, userSteps);
    }

    log.info(
        "Keeping {} planner phases (user plan has {} steps) — no engineering expand",
        phases.size(),
        userSteps.size());
    return linkPhasesToSteps(phases, userSteps);
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
    Map<String, Object> phase = new LinkedHashMap<>(template); // preserve ALL LLM-declared fields
    phase.put("id", "p" + (index + 1));
    Object title = step.get("title");
    phase.put("title", title != null && !title.toString().isBlank() ? title : "Step " + (index + 1));
    Object stepIntent = step.get("intent");
    String resolvedIntent;
    if (stepIntent != null && !stepIntent.toString().isBlank()) {
      resolvedIntent = stepIntent.toString();
    } else {
      resolvedIntent = String.valueOf(template.getOrDefault("intent", "code-change"));
    }
    phase.put("intent", resolvedIntent);
    phase.put("entry", template.getOrDefault("entry", List.of()));
    phase.put("exit", template.getOrDefault("exit", List.of()));
    phase.put("budget", template.getOrDefault("budget", Map.of("attempts", 3)));

    // ★ When expanding from a single template phase, the LLM didn't provide per-phase
    // tags/memoryHints/loadShardMode. Infer them from the step's intent and title
    // so that PhaseAwareMemoryLoader can do meaningful retrieval.
    if (!template.containsKey("tags") || !(template.get("tags") instanceof List<?> lt) || lt.isEmpty()) {
      List<String> inferredTags = inferTagsFromStep(resolvedIntent, title != null ? title.toString() : "");
      phase.put("tags", inferredTags);
    }
    if (!template.containsKey("memoryHints") || template.get("memoryHints") == null) {
      phase.put("memoryHints", List.of());
    }
    if (!template.containsKey("loadShardMode")) {
      phase.put("loadShardMode", "tags");
    }

    attachStep(phase, index, step);
    return phase;
  }

  /**
   * Infer tags from step intent and title for phase-aware memory retrieval.
   * When the LLM returned a single template phase (no per-step tags), this ensures
   * that expanded phases still have meaningful tags for ContextShardResolver.
   */
  private static List<String> inferTagsFromStep(String intent, String title) {
    List<String> tags = new ArrayList<>();
    tags.add("step-intent-" + intent);
    // Extract key nouns from title (words > 3 chars, excluding common verbs)
    if (title != null && !title.isBlank()) {
      String[] words = title.split("[\\s,/，、]+");
      for (String word : words) {
        // Include meaningful words as tags (both English and Chinese terms)
        if (word.length() > 2 || word.matches(".*[\\u4e00-\\u9fa5].*")) {
          tags.add(word.toLowerCase());
        }
      }
    }
    // Keep tags list bounded
    if (tags.size() > 8) {
      tags = tags.subList(0, 8);
    }
    return tags;
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
