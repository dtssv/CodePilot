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
   * @param stepKind active plan step kind (from {@link PhaseGoalHelper}); when set, blocks redundant
   *     compile/run after the step goal is already satisfied
   */
  public static Optional<String> blockReason(
      String command,
      String projectMeta,
      String userInput,
      Map<String, Object> gathered,
      PhaseGoalHelper.StepKind stepKind) {
    if (command == null || command.isBlank()) {
      return Optional.empty();
    }
    String norm = normalize(command);
    if (stepKind != null && gathered != null && !gathered.isEmpty()) {
      if (stepKind == PhaseGoalHelper.StepKind.COMPILE
          && PhaseGoalHelper.hasSuccessfulCompile(gathered)
          && looksLikeCompile(norm)) {
        return Optional.of(
            "Skipped: compile for this step already succeeded in [GATHERED CONTEXT]. "
                + "Use textOutput to summarize and proceed — do not rebuild.");
      }
      if (stepKind == PhaseGoalHelper.StepKind.RUN
          && PhaseGoalHelper.hasSuccessfulRun(gathered)
          && looksLikeRun(norm)) {
        return Optional.of(
            "Skipped: run for this step already succeeded. Use textOutput to summarize and proceed.");
      }
      if (stepKind == PhaseGoalHelper.StepKind.COMPILE
          && isRepeatedFailedShell(gathered, norm)
          && norm.contains("cmake")
          && !norm.contains("--build")) {
        return Optional.of(
            "Skipped: cmake configure already failed. Use g++/make or another build tool, "
                + "or use textOutput if compile already succeeded via another command.");
      }
    }
    if (isDuplicateShell(gathered, norm)) {
      return Optional.of(
          "Skipped: this exact command already ran in this turn. Read [GATHERED CONTEXT] and choose the next step toward the user's goal.");
    }
    if (isRepeatedFailedShell(gathered, norm)) {
      return Optional.of(
          "Skipped: this command already failed in this turn. Read stderr in [GATHERED CONTEXT] and try a different approach — do not rerun the same command.");
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
      if (normalizedCommand.equals(normalize(shellCommandFromEntry(entry)))) {
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
    return norm.contains("g++")
        || norm.contains("clang++")
        || norm.contains("cmake --build")
        || norm.matches("(?i).*\\bmake\\b.*")
        || norm.contains("mvn ")
        || norm.contains("gradle ");
  }

  private static boolean looksLikeRun(String norm) {
    return norm.startsWith("./") || norm.contains(" ./") || norm.contains("./main");
  }
}
