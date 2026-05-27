package io.codepilot.core.graph;

import java.util.Map;
import java.util.Optional;

/**
 * Prevents pointless shell loops within one graph turn (exact duplicate, or repeating a command
 * that already failed). Does not ban command types — intent alignment is guided via prompts and
 * {@link CompileHintHelper}.
 */
public final class ShellCommandGate {

  private ShellCommandGate() {}

  public static boolean isCompileRunIntent(String userInput) {
    if (userInput == null || userInput.isBlank()) {
      return false;
    }
    String lower = userInput.toLowerCase();
    return lower.contains("编译")
        || lower.contains("运行")
        || lower.contains("compile")
        || lower.contains("build")
        || lower.contains("run ")
        || lower.contains("execute")
        || lower.matches(".*\\brun\\b.*");
  }

  /**
   * @return reason to skip execution when the same command would not add new information
   */
  @SuppressWarnings("unchecked")
  public static Optional<String> blockReason(
      String command, String projectMeta, String userInput, Map<String, Object> gathered) {
    return blockReason(command, projectMeta, userInput, gathered, null);
  }

  /**
   * @return reason to skip execution when the same command would not add new information
   */
  @SuppressWarnings("unchecked")
  public static Optional<String> blockReason(
      String command, String projectMeta, String userInput, Map<String, Object> gathered,
      PhaseGoalHelper.StepKind stepKind) {
    return blockReason(command, projectMeta, userInput, gathered, stepKind, null);
  }

  /**
   * @param stepKind active plan step kind (from {@link PhaseGoalHelper}); when set, blocks redundant
   *     compile/run after the step goal is already satisfied
   * @param purpose LLM-declared purpose for this shell.exec (compile/run/probe/configure/other);
   *     when set, used instead of command-shape heuristics for classification
   */
  public static Optional<String> blockReason(
      String command,
      String projectMeta,
      String userInput,
      Map<String, Object> gathered,
      PhaseGoalHelper.StepKind stepKind,
      String purpose) {
    if (command == null || command.isBlank()) {
      return Optional.empty();
    }
    String norm = normalize(command);
    if (stepKind != null && gathered != null && !gathered.isEmpty()) {
      if ((stepKind == PhaseGoalHelper.StepKind.COMPILE || stepKind == PhaseGoalHelper.StepKind.VERIFY)
          && PhaseGoalHelper.hasSuccessfulCompile(gathered)
          && looksLikeCompile(norm, purpose)) {
        return Optional.of(
            "Skipped: compile for this step already succeeded in [GATHERED CONTEXT]. "
                + "Use textOutput to summarize and proceed — do not rebuild.");
      }
      if ((stepKind == PhaseGoalHelper.StepKind.RUN || stepKind == PhaseGoalHelper.StepKind.VERIFY)
          && PhaseGoalHelper.hasSuccessfulRun(gathered)
          && looksLikeRun(norm, purpose)) {
        return Optional.of(
            "Skipped: run for this step already succeeded. Use textOutput to summarize and proceed.");
      }
      if ((stepKind == PhaseGoalHelper.StepKind.COMPILE || stepKind == PhaseGoalHelper.StepKind.VERIFY)
          && isRepeatedFailedShell(gathered, norm)
          && looksLikeConfigure(norm, purpose)) {
        return Optional.of(
            "Skipped: this configure/setup command already failed. Try a different build or compile approach, "
                + "or use textOutput if compile already succeeded via another command.");
      }
    }
    if (isRepeatedFailedShell(gathered, norm)) {
      return Optional.of(
          "Skipped: this command already failed in this turn. Read stderr in [GATHERED CONTEXT] and try a different approach — do not rerun the same command.");
    }
    if (isDuplicateShell(gathered, norm)) {
      return Optional.of(
          "Skipped: this exact command already ran in this turn. Read [GATHERED CONTEXT] and choose the next step toward the user's goal.");
    }
    return Optional.empty();
  }

  @SuppressWarnings("unchecked")
  private static boolean isDuplicateShell(Map<String, Object> gathered, String normalizedCommand) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> entry)) {
        continue;
      }
      if (!"shell.exec".equals(String.valueOf(entry.get("kind")))) {
        continue;
      }
      if (!normalizedCommand.equals(normalize(shellCommandFromEntry(entry)))) {
        continue;
      }
      if (GatheredInfoFormatter.entrySucceeded((Map<String, Object>) entry)) {
        return true;
      }
    }
    return false;
  }

  @SuppressWarnings("unchecked")
  private static boolean isRepeatedFailedShell(Map<String, Object> gathered, String normalizedCommand) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> entry)) {
        continue;
      }
      if (!"shell.exec".equals(String.valueOf(entry.get("kind")))) {
        continue;
      }
      if (!normalizedCommand.equals(normalize(shellCommandFromEntry(entry)))) {
        continue;
      }
      if (Boolean.FALSE.equals(entry.get("ok"))
          || entry.containsKey("error")
          || entry.containsKey("errorMessage")) {
        return true;
      }
      Object result = entry.get("result");
      if (result instanceof Map<?, ?> m) {
        Object exit = m.get("exitCode");
        if (exit instanceof Number n && n.intValue() != 0) {
          return true;
        }
      }
    }
    return false;
  }

  private static String shellCommandFromEntry(Map<?, ?> entry) {
    Object result = entry.get("result");
    if (result instanceof Map<?, ?> m) {
      Object cmd = m.get("command");
      if (cmd != null && !cmd.toString().isBlank()) {
        return cmd.toString();
      }
    }
    return "";
  }

  static String normalize(String command) {
    return command.trim().replaceAll("\\s+", " ");
  }

  private static boolean looksLikeCompile(String norm) {
    return looksLikeCompile(norm, null);
  }

  private static boolean looksLikeCompile(String norm, String purpose) {
    // Model-declared purpose takes priority over command-shape heuristics
    if (purpose != null && !purpose.isBlank()) {
      return "compile".equalsIgnoreCase(purpose) || "configure".equalsIgnoreCase(purpose);
    }
    return norm.contains("g++")
        || norm.contains("clang++")
        || norm.contains("cmake --build")
        || norm.matches("(?i).*\\bmake\\b.*")
        || norm.contains("mvn ")
        || norm.contains("gradle ");
  }

  private static boolean looksLikeRun(String norm) {
    return looksLikeRun(norm, null);
  }

  private static boolean looksLikeRun(String norm, String purpose) {
    if (purpose != null && !purpose.isBlank()) {
      return "run".equalsIgnoreCase(purpose);
    }
    return norm.startsWith("./") || norm.contains(" ./") || norm.contains("./main");
  }

  /** Heuristic: command looks like a project configure/setup step (not a build invocation). */
  private static boolean looksLikeConfigure(String norm) {
    return looksLikeConfigure(norm, null);
  }

  /** Heuristic: command looks like a project configure/setup step (not a build invocation). */
  private static boolean looksLikeConfigure(String norm, String purpose) {
    if (purpose != null && !purpose.isBlank()) {
      return "configure".equalsIgnoreCase(purpose);
    }
    // cmake without --build = configure; autogen/configure/autoreconf are also configure steps
    if (norm.contains("cmake") && !norm.contains("--build")) {
      return true;
    }
    return norm.contains("./configure")
        || norm.contains("autoreconf")
        || norm.contains("autogen")
        || norm.contains("meson setup");
  }
}
