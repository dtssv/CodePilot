package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Session-wide staged execution log: snapshots tool/gather outcomes per phase boundary and
 * injects them into later prompts so context is not lost when {@code gatheredInfo} is trimmed.
 */
public final class GraphExecutionJournal {

  public static final String STATE_KEY = "graphExecutionJournal";

  private static final String KEY_STAGES = "stages";
  private static final int MAX_STAGES = 32;
  private static final int INJECT_STAGE_COUNT = 8;
  private static final int MAX_DIGEST_CHARS = 2400;
  private static final int MAX_SUMMARY_CHARS = 400;

  private GraphExecutionJournal() {}

  @SuppressWarnings("unchecked")
  public static Map<String, Object> fromState(OverAllState state) {
    if (state == null) {
      return newJournal();
    }
    Object raw = state.value(STATE_KEY).orElse(null);
    if (raw instanceof Map<?, ?> m) {
      Map<String, Object> journal = new LinkedHashMap<>((Map<String, Object>) m);
      ensureStagesList(journal);
      return journal;
    }
    return newJournal();
  }

  public static void putInUpdates(Map<String, Object> updates, Map<String, Object> journal) {
    if (journal != null) {
      updates.put(STATE_KEY, journal);
    }
  }

  /**
   * Archive the current phase/node outcome before {@code gatheredInfo} is cleared or the cursor
   * advances.
   */
  @SuppressWarnings("unchecked")
  public static void recordPhaseBoundary(
      OverAllState state,
      Map<String, Object> updates,
      String phaseId,
      String node,
      String outcome,
      Map<String, Object> gathered) {
    Map<String, Object> journal = fromState(state);
    if (updates.containsKey(STATE_KEY)) {
      journal = fromUpdates(updates);
    }

    Map<String, Object> stage = new LinkedHashMap<>();
    stage.put("seq", stages(journal).size() + 1);
    stage.put("phaseId", phaseId != null ? phaseId : "");
    stage.put("node", node != null ? node : "unknown");
    stage.put("stepLabel", PhaseGoalHelper.currentStepLabel(state));
    stage.put("outcome", outcome != null ? outcome : "unknown");
    stage.put("summary", buildSummary(state, gathered, outcome));
    stage.put("gatheredDigest", digestGathered(gathered));
    stage.put("modifiedFiles", snapshotList(state.value("modifiedFiles").orElse(List.of())));
    stage.put(
        "signals",
        Map.of(
            "generateResult", stringOr(state.value("generateResult").orElse(""), ""),
            "verifyResult", stringOr(state.value("verifyResult").orElse(""), ""),
            "repairResult", stringOr(state.value("repairResult").orElse(""), ""),
            "toolFailures",
            PhaseOutcomeHelper.rawToolsHadFailure(state)
                || PhaseOutcomeHelper.gatheredHasFailures(gathered != null ? gathered : Map.of()),
            "goalMet", PhaseGoalHelper.currentStepGoalSatisfied(state, gathered)));

    appendStage(journal, stage);
    putInUpdates(updates, journal);
  }

  /** Lightweight record for repair/generate routing without a full phase commit. */
  public static void recordNodeOutcome(
      OverAllState state, Map<String, Object> updates, String node, String outcome) {
    @SuppressWarnings("unchecked")
    Map<String, Object> gathered =
        (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
    recordPhaseBoundary(
        state,
        updates,
        (String) state.value("phaseCursor").orElse(""),
        node,
        outcome,
        gathered);
  }

  /**
   * Prompt block: recent staged steps (full digests for current phase, summaries for earlier
   * phases).
   */
  public static String promptDirective(OverAllState state) {
    List<Map<String, Object>> stages = stages(fromState(state));
    if (stages.isEmpty()) {
      return "";
    }
    String currentPhase = (String) state.value("phaseCursor").orElse("");
    int start = Math.max(0, stages.size() - INJECT_STAGE_COUNT);
    List<Map<String, Object>> recent = stages.subList(start, stages.size());

    StringBuilder sb = new StringBuilder();
    sb.append("\n\n[EXECUTION HISTORY — staged context from earlier steps in this session]\n");
    sb.append(
        "The checklist and [GATHERED CONTEXT] may only show the current step. Use this history "
            + "for what already ran, failed, or produced artifacts.\n");

    for (Map<String, Object> stage : recent) {
      String phaseId = stringOr(stage.get("phaseId"), "");
      boolean samePhase = phaseId.equals(currentPhase);
      sb.append("- Phase ")
          .append(phaseId)
          .append(" / ")
          .append(stage.getOrDefault("node", ""))
          .append(" [")
          .append(stage.getOrDefault("outcome", ""))
          .append("]: ")
          .append(stage.getOrDefault("summary", ""))
          .append('\n');
      if (samePhase) {
        appendDigest(sb, stage);
      } else {
        String digest = stringOr(stage.get("gatheredDigest"), "");
        if (!digest.isBlank() && digest.length() <= 600) {
          appendDigest(sb, stage);
        }
      }
      Object files = stage.get("modifiedFiles");
      if (files instanceof List<?> list && !list.isEmpty()) {
        sb.append("  modified: ").append(String.join(", ", list.stream().map(Object::toString).toList()))
            .append('\n');
      }
    }
    return sb.toString();
  }

  /** Combined injection for graph LLM nodes. */
  public static String combinedContextDirective(OverAllState state) {
    String journal = promptDirective(state);
    String facts = SessionExecutionFacts.adaptationDirective(state);
    if (journal.isBlank()) {
      return facts;
    }
    if (facts.isBlank()) {
      return journal;
    }
    return journal + facts;
  }

  public static void clearEphemeralNodeState(Map<String, Object> updates) {
    updates.remove("repairContext");
    updates.remove("verifyReport");
    updates.remove("verifyResult");
    updates.put("repairResult", "");
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private static Map<String, Object> newJournal() {
    Map<String, Object> journal = new LinkedHashMap<>();
    journal.put(KEY_STAGES, new ArrayList<Map<String, Object>>());
    return journal;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> fromUpdates(Map<String, Object> updates) {
    Object raw = updates.get(STATE_KEY);
    if (raw instanceof Map<?, ?> m) {
      Map<String, Object> journal = new LinkedHashMap<>((Map<String, Object>) m);
      ensureStagesList(journal);
      return journal;
    }
    return newJournal();
  }

  @SuppressWarnings("unchecked")
  private static void ensureStagesList(Map<String, Object> journal) {
    if (!(journal.get(KEY_STAGES) instanceof List<?>)) {
      journal.put(KEY_STAGES, new ArrayList<Map<String, Object>>());
    }
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> stages(Map<String, Object> journal) {
    ensureStagesList(journal);
    return (List<Map<String, Object>>) journal.get(KEY_STAGES);
  }

  private static void appendStage(Map<String, Object> journal, Map<String, Object> stage) {
    List<Map<String, Object>> list = stages(journal);
    list.add(stage);
    while (list.size() > MAX_STAGES) {
      list.remove(0);
      for (int i = 0; i < list.size(); i++) {
        list.get(i).put("seq", i + 1);
      }
    }
  }

  private static String digestGathered(Map<String, Object> gathered) {
    if (gathered == null || gathered.isEmpty()) {
      return "";
    }
    String formatted = GatheredInfoFormatter.format(gathered);
    if (formatted.isBlank()) {
      String failures = GatheredInfoFormatter.formatFailures(gathered);
      return truncate(failures, MAX_DIGEST_CHARS);
    }
    return truncate(formatted, MAX_DIGEST_CHARS);
  }

  @SuppressWarnings("unchecked")
  private static String buildSummary(
      OverAllState state, Map<String, Object> gathered, String outcome) {
    StringBuilder sb = new StringBuilder();
    sb.append(PhaseGoalHelper.currentStepLabel(state));
    if (!outcome.isBlank()) {
      sb.append(" — ").append(outcome);
    }
    String gen = stringOr(state.value("generateResult").orElse(""), "");
    if (!gen.isBlank()) {
      sb.append("; generate=").append(gen);
    }
    if (gathered != null && PhaseOutcomeHelper.gatheredHasFailures(gathered)) {
      sb.append("; tools had failures");
    } else if (PhaseOutcomeHelper.rawToolsHadFailure(state)) {
      sb.append("; tools had failures");
    }
    List<String> modified = snapshotList(state.value("modifiedFiles").orElse(List.of()));
    if (!modified.isEmpty()) {
      sb.append("; files=").append(String.join(", ", modified.size() > 5 ? modified.subList(0, 5) : modified));
      if (modified.size() > 5) {
        sb.append("…");
      }
    }
    return truncate(sb.toString(), MAX_SUMMARY_CHARS);
  }

  private static void appendDigest(StringBuilder sb, Map<String, Object> stage) {
    String digest = stringOr(stage.get("gatheredDigest"), "");
    if (!digest.isBlank()) {
      sb.append("  ```\n").append(digest).append("\n  ```\n");
    }
  }

  @SuppressWarnings("unchecked")
  private static List<String> snapshotList(Object raw) {
    if (!(raw instanceof List<?> list)) {
      return List.of();
    }
    List<String> out = new ArrayList<>();
    for (Object o : list) {
      if (o != null && !o.toString().isBlank()) {
        out.add(o.toString());
      }
    }
    return List.copyOf(out);
  }

  private static String stringOr(Object value, String def) {
    return value != null && !value.toString().isBlank() ? value.toString().trim() : def;
  }

  private static String truncate(String s, int max) {
    if (s == null || s.length() <= max) {
      return s == null ? "" : s;
    }
    return s.substring(0, max) + "...";
  }
}
