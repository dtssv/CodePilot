package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.dto.Patch;
import io.codepilot.core.graph.actions.VerifyAction.VerifyFinding;
import io.codepilot.core.graph.actions.VerifyAction.VerifyReport;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Routes failed plan steps to {@code repair} with raw tool/build evidence — no scenario taxonomy.
 */
public final class PhaseFailureRepairHelper {

  public static final int MAX_PHASE_FAILURE_ATTEMPTS = 10;

  /**
   * Resolve the effective max failure attempts: state override → hardcoded default.
   * The state key "maxPhaseFailureAttempts" is set by IntakeAction from GraphEngineProperties.
   */
  public static int resolveMaxFailureAttempts(OverAllState state) {
    Object val = state.value("maxPhaseFailureAttempts").orElse(null);
    if (val instanceof Number num && num.intValue() > 0) {
      return num.intValue();
    }
    return MAX_PHASE_FAILURE_ATTEMPTS;
  }

  /** Shown to the repair LLM; diagnosis and fix strategy are left to the model. */
  public static final String GENERIC_REPAIR_DIRECTIVE =
      """
      [FAILURE REPAIR]
      The current plan step did not complete successfully. Read [FAILED TOOL / BUILD OUTPUT] and
      [VERIFICATION FAILURES] below, plus session execution facts.
      Diagnose the root cause yourself and apply the minimal fix (update existing files, change
      commands or paths, retry tools). Do NOT create new source or test files unless the step truly
      requires a brand-new path and no existing project file can be updated.
      """;

  private PhaseFailureRepairHelper() {}

  public static int failureAttempts(OverAllState state) {
    return (int) state.value("phaseFailureRetries").orElse(0);
  }

  public static boolean shouldAbandonPhase(OverAllState state) {
    return failureAttempts(state) >= resolveMaxFailureAttempts(state);
  }

  public static void incrementFailureAttempts(Map<String, Object> updates, OverAllState state) {
    updates.put("phaseFailureRetries", failureAttempts(state) + 1);
  }

  /** Clears per-phase retry counters after abandoning or completing recovery. */
  public static void clearPhaseAttemptCounters(Map<String, Object> updates) {
    StuckStepRecovery.clearStuckCounters(updates);
    updates.put("phaseGeneratePasses", 0);
    updates.put("attempts", Map.of());
    updates.put("approachEscalationDone", false);
  }

  /**
   * True when tools failed, the step goal is still unmet, and attempts remain.
   */
  public static boolean shouldRouteToRepair(OverAllState state) {
    if (shouldAbandonPhase(state)) {
      return false;
    }
    if (PhaseGoalHelper.currentStepGoalSatisfied(state)) {
      return false;
    }
    return PhaseOutcomeHelper.rawToolsHadFailure(state)
        || PhaseOutcomeHelper.hasToolFailures(state);
  }

  /**
   * Populates {@code verifyReport}, {@code verifyResult}, and {@code repairContext} for RepairAction.
   */
  @SuppressWarnings("unchecked")
  public static void prepareRepairFromFailures(OverAllState state, Map<String, Object> updates) {
    Map<String, Object> gathered =
        (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
    List<VerifyFinding> findings = findingsFromGathered(gathered);
    String failureSummary = GatheredInfoFormatter.formatFailures(gathered);

    Map<String, Object> context = new LinkedHashMap<>();
    String directive = GENERIC_REPAIR_DIRECTIVE;
    if (linkerMissingMain(failureSummary)) {
      directive +=
          """

          [LINKER HINT]
          Undefined symbol `_main` usually means you linked a library/solution .cpp without a program entry.
          Fix by either: (1) shell.exec with g++ including BOTH the solution and a test/driver .cpp that defines main,
          or (2) fs.replace adding a minimal main in an existing test file — do NOT emit empty fs.replace patches.
          """;
    }
    context.put("directive", directive);
    context.put("failureSummary", failureSummary);
    context.put("stepLabel", PhaseGoalHelper.currentStepLabel(state));
    context.put("attempt", failureAttempts(state) + 1);
    context.put("maxAttempts", MAX_PHASE_FAILURE_ATTEMPTS);

    updates.put("verifyResult", "fail");
    updates.put(
        "verifyReport",
        new VerifyReport("fail", findings, List.of(), List.of(), 0).toMap());
    updates.put("repairContext", context);
    updates.put("phaseCommitBlocked", true);
    if (state.value("verifyReport").isEmpty()) {
      incrementFailureAttempts(updates, state);
    }
  }

  /**
   * During recovery, prefer patching existing session outputs over spawning new paths.
   */
  public static boolean shouldPreferFixOverCreate(OverAllState state, Patch.Edit.Op op) {
    if (op != Patch.Edit.Op.CREATE) {
      return false;
    }
    if (!SessionExecutionFacts.hasWrittenOutputs(state)) {
      return false;
    }
    if (!shouldRouteToRepair(state) && state.value("repairContext").isEmpty()) {
      return false;
    }
    return true;
  }

  private static boolean linkerMissingMain(String failureSummary) {
    if (failureSummary == null || failureSummary.isBlank()) {
      return false;
    }
    String lower = failureSummary.toLowerCase();
    return lower.contains("undefined symbols")
        && (lower.contains("_main") || lower.contains("symbol(s) not found"));
  }

  @SuppressWarnings("unchecked")
  private static List<VerifyFinding> findingsFromGathered(Map<String, Object> gathered) {
    List<VerifyFinding> findings = new ArrayList<>();
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      String kind = String.valueOf(entry.getOrDefault("kind", "tool"));
      String id = String.valueOf(entry.getOrDefault("id", "failure"));
      String message = failureMessage(entry);
      findings.add(
          new VerifyFinding(id, 0, "error", truncate(message, 800), kind));
    }
    if (findings.isEmpty()) {
      findings.add(
          new VerifyFinding("step", 0, "error", "Tool or build step failed", "unknown"));
    }
    return findings;
  }

  @SuppressWarnings("unchecked")
  private static String failureMessage(Map<String, Object> entry) {
    String msg =
        stringOr(
            entry.get("errorMessage"),
            entry.get("error"),
            entry.get("errorCode"),
            "");
    Object result = entry.get("result");
    if (result instanceof Map<?, ?> resultMap) {
      Map<String, Object> shell = (Map<String, Object>) resultMap;
      String cmd = String.valueOf(shell.getOrDefault("command", ""));
      String stderr = stringOr(shell.get("stderr"), shell.get("error"), "");
      String stdout = stringOr(shell.get("stdout"), "");
      StringBuilder sb = new StringBuilder();
      if (!msg.isBlank()) {
        sb.append(msg);
      }
      if (!cmd.isBlank()) {
        if (!sb.isEmpty()) {
          sb.append("\n");
        }
        sb.append("command: ").append(cmd);
      }
      if (!stderr.isBlank()) {
        if (!sb.isEmpty()) {
          sb.append("\n");
        }
        sb.append("stderr:\n").append(stderr);
      }
      if (!stdout.isBlank()) {
        if (!sb.isEmpty()) {
          sb.append("\n");
        }
        sb.append("stdout:\n").append(stdout);
      }
      if (!sb.isEmpty()) {
        return sb.toString();
      }
    }
    return msg.isBlank() ? "unknown error" : msg;
  }

  private static String stringOr(Object... values) {
    for (Object v : values) {
      if (v != null && !v.toString().isBlank()) {
        return v.toString();
      }
    }
    return "";
  }

  private static String truncate(String s, int max) {
    if (s == null || s.length() <= max) {
      return s == null ? "" : s;
    }
    return s.substring(0, max) + "...";
  }
}
