package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Handles user answers to {@link GraphUserMessages#stepStuckQuestion} and resume dead-loops. */
public final class StuckStepRecovery {

  private static final Logger log = LoggerFactory.getLogger(StuckStepRecovery.class);

  private static final String QUESTION_PREFIX = "step-stuck-";

  private StuckStepRecovery() {}

  public static String questionId(String phaseId) {
    return QUESTION_PREFIX + phaseId;
  }

  /** True when failure-retry budget is exhausted and we should show the stuck-step question. */
  public static boolean shouldEscalateToAskUser(OverAllState state) {
    int failureRetries = (int) state.value("phaseFailureRetries").orElse(0);
    if (failureRetries < GraphLoopBudget.stuckEscalationThreshold(state)) {
      return false;
    }
    if (!PhaseOutcomeHelper.rawToolsHadFailure(state)) {
      return false;
    }
    if (PhaseGoalHelper.currentStepGoalSatisfied(state)) {
      return false;
    }
    return !wasStuckQuestionAnswered(state);
  }

  public static boolean wasStuckQuestionAnswered(OverAllState state) {
    return resolveAnsweredOption(state, currentPhaseId(state)) != null;
  }

  /**
   * Applies the user's stuck-step choice into {@code updates} (resume / next generate entry).
   * Returns early-exit {@code generateResult} when present (e.g. abort).
   */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> consumeStuckAnswerIfPresent(OverAllState state) {
    String phaseId = currentPhaseId(state);
    String option = resolveAnsweredOption(state, phaseId);
    if (option == null) {
      return Map.of();
    }
    var updates = new HashMap<String, Object>();
    applyOption(updates, option);
    updates.put("askUserQuestion", null);
    log.info("StuckStepRecovery: applied option '{}' for phase {}", option, phaseId);
    return updates;
  }

  /** Same as {@link #consumeStuckAnswerIfPresent} but mutates a restored state map. */
  public static void applyAnsweredStuckStep(Map<String, Object> restored) {
    String phaseId = String.valueOf(restored.getOrDefault("phaseCursor", ""));
    String option = resolveAnsweredOptionFromLedger(restored, phaseId);
    if (option == null) {
      return;
    }
    applyOption(restored, option);
    restored.remove("askUserQuestion");
    log.info("StuckStepRecovery: restored checkpoint option '{}' for phase {}", option, phaseId);
  }

  public static String analyzeTextOutputDirective(OverAllState state, Map<String, Object> gathered) {
    if (PhaseGoalHelper.inferStepKind(state) != PhaseGoalHelper.StepKind.ANALYZE) {
      return "";
    }
    if (!PhaseGoalHelper.hasSuccessfulSourceRead(gathered)
        && !PhaseGoalHelper.sessionHasSourceReads(state)) {
      return "";
    }
    return "\n\n[MANDATORY — ANALYZE STEP]\n"
        + "Source file contents are already in [GATHERED CONTEXT].\n"
        + "Do NOT call fs.list or re-read the same paths.\n"
        + "You MUST set textOutput with the analysis required by this plan step "
        + "(use the sources already gathered).\n"
        + "toolCalls may only target files not yet present in [GATHERED CONTEXT].\n";
  }

  private static void applyOption(Map<String, Object> target, String option) {
    String choice = option.toLowerCase(Locale.ROOT);
    switch (choice) {
      case "skip" -> {
        clearStuckCounters(target);
        target.put("phaseHasAnalysisOutput", true);
      }
      case "abort" -> {
        target.put("generateResult", "failed");
        target.put("doneReason", "user_abort");
      }
      case "alternative" -> clearStuckCounters(target);
      default -> clearStuckCounters(target);
    }
    ToolApproachTracker.clearInPhase(target);
  }

  public static void clearStuckCounters(Map<String, Object> target) {
    target.put("phaseFailureRetries", 0);
    target.put("phaseToolsHadFailure", false);
    target.put("phaseCommitBlocked", false);
    target.put("approachRepeatBlocked", false);
    target.put("directToolRound", 0);
  }

  private static String currentPhaseId(OverAllState state) {
    return String.valueOf(state.value("phaseCursor").orElse(""));
  }

  @SuppressWarnings("unchecked")
  private static String resolveAnsweredOption(OverAllState state, String phaseId) {
    if (phaseId.isBlank()) {
      return null;
    }
    String fromLedger = resolveAnsweredOptionFromLedger(state.data(), phaseId);
    if (fromLedger != null) {
      return fromLedger;
    }
    List<?> answers = (List<?>) state.value("answers").orElse(List.of());
    for (Object raw : answers) {
      if (raw instanceof Map<?, ?> m) {
        Map<String, Object> answer = (Map<String, Object>) m;
        Object qid = answer.get("questionId");
        if (qid != null && questionId(phaseId).equals(qid.toString())) {
          Object optionId = answer.get("optionId");
          if (optionId != null && !optionId.toString().isBlank()) {
            return optionId.toString();
          }
        }
      }
    }
    return null;
  }

  @SuppressWarnings("unchecked")
  private static String resolveAnsweredOptionFromLedger(Map<String, Object> data, String phaseId) {
    if (phaseId.isBlank()) {
      return null;
    }
    Map<String, Object> ledger =
        (Map<String, Object>) data.getOrDefault("taskLedger", Map.of());
    List<String> notes = new ArrayList<>();
    Object rawNotes = ledger.get("notes");
    if (rawNotes instanceof List<?> list) {
      for (Object n : list) {
        if (n != null) {
          notes.add(n.toString());
        }
      }
    }
    String prefix = "answered:" + questionId(phaseId) + "=";
    for (String note : notes) {
      if (note.startsWith(prefix)) {
        return note.substring(prefix.length()).trim();
      }
    }
    return null;
  }
}
