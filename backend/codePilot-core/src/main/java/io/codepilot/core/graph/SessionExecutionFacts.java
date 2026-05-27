package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Session-wide execution context learned from tool results (persists across plan steps/phases).
 *
 * <p>Plans are written before tools run. As steps execute, failures and successes reveal a
 * different effective path (build tool, test runner, target file, API, directory, etc.). Later
 * steps must follow {@linkplain #primaryTargets(OverAllState) primary targets} and ignore stale
 * plan wording — not only in compile/run scenarios.
 */
public final class SessionExecutionFacts {

  public static final String STATE_KEY = "sessionExecutionFacts";

  /** @deprecated use {@link #KEY_PLAN_PIVOT}; kept when reading old checkpoints */
  @Deprecated
  private static final String LEGACY_BUILD_PIVOT = "buildPivot";

  private static final String KEY_PLAN_PIVOT = "planPivot";
  private static final String KEY_PIVOT_SUMMARY = "pivotSummary";
  private static final String KEY_FAILED = "failedAttempts";
  private static final String KEY_SUCCESSFUL = "successfulOutcomes";
  private static final String KEY_PRIMARY_TARGETS = "primaryTargets";
  private static final String KEY_TOUCHED_PATHS = "touchedPaths";
  /** Output files successfully written via fs.applyPatch this session (normalized paths). */
  private static final String KEY_WRITTEN_FILES = "writtenFiles";
  private static final String KEY_SUCCESSFUL_FAMILIES = "successfulFamilies";
  private static final String KEY_FAILED_FAMILIES = "failedFamilies";
  /** Shell execution history for LLM context: each entry is "family|command|exitCode|ok|errorSnippet".
   *  Covers all scenarios: tool-missing (exit!=0), compilation errors (exit!=0),
   *  successful-but-unsatisfied (exit=0, e.g. tail -n 10 found nothing), etc.
   *  The LLM evaluates these and decides: switch command, fix source and retry, or expand scope. */
  private static final String KEY_FAILED_DETAILS = "shellHistory";

  /** Shell CLI flag shape (-o / --output), not natural-language step titles. */
  private static final Pattern SHELL_OUTPUT_FLAG =
      Pattern.compile("(?i)\\s-(?:o|out|output)\\s+([^\\s'\"]+)");
  /**
   * Path-like tokens in commands/labels (slashes, extensions). Used for stale-path detection, not
   * for classifying step intent.
   */
  private static final Pattern PATH_IN_TEXT =
      Pattern.compile(
          "(?:[\\w.-]+/)+[\\w.-]+|(?:\\./)?[\\w.-]+\\.(?:cpp|hpp|h|c|java|kt|py|js|ts|go|rs|md|json|ya?ml|xml|gradle|toml)|build/|src/|dist/|target/");

  /** Common source extensions — used only to prioritize paths from listings, not to match filenames. */
  private static final Pattern SOURCE_FILE_EXT =
      Pattern.compile(
          "(?i).+\\.(cpp|hpp|h|c|cc|cxx|java|kt|py|js|ts|tsx|jsx|go|rs|rb|php|cs|swift|m|mm|scala|vue|svelte)$");

  private static final int MAX_TARGETS_FROM_LIST = 32;

  private SessionExecutionFacts() {}

  @SuppressWarnings("unchecked")
  public static Map<String, Object> fromState(OverAllState state) {
    if (state == null) {
      return new LinkedHashMap<>();
    }
    Object raw = state.value(STATE_KEY).orElse(null);
    if (raw instanceof Map<?, ?> m) {
      return migrateLegacyKeys(new LinkedHashMap<>((Map<String, Object>) m));
    }
    return new LinkedHashMap<>();
  }

  public static Map<String, Object> mergeFromGathered(
      OverAllState state, Map<String, Object> gathered) {
    Map<String, Object> facts = fromState(state);
    if (gathered == null || gathered.isEmpty()) {
      return facts;
    }
    mergeGatheredInto(facts, gathered);
    // ★ Re-prioritize primaryTargets: files modified in the current session
    // (from "modifiedFiles" state key) should take precedence over files
    // discovered from directory listings. Without this, a directory listing
    // may place unrelated files (e.g. LRU.h) ahead of the user's actual
    // target (e.g. leetcode42.cpp), causing staleProbeBlockReason to
    // incorrectly block shell commands that reference the real target.
    if (state != null) {
      reprioritizeTargetsFromModifiedFiles(state, facts);
    }
    return facts;
  }

  public static void putInUpdates(Map<String, Object> updates, Map<String, Object> facts) {
    if (facts != null && !facts.isEmpty()) {
      updates.put(STATE_KEY, facts);
    }
  }

  /** Clear per-phase history (shellHistory) when advancing to the next phase.
   *  This allows the LLM to start fresh in a new phase without being constrained
   *  by stale command history from previous phases. Persistent facts (failedFamilies,
   *  successFamilies, primaryTargets, planPivot) are retained across phases.
   *  <p>Also clears writtenFiles so that subsequent phases can modify files
   *  that were written in earlier phases. Multi-step plans (e.g. refactoring
   *  multiple functions in the same file) require each phase to be able to
   *  patch the same file. The "already-written" guard is still effective within
   *  a single phase to prevent duplicate writes, but should not block
   *  legitimate incremental edits across phases. */
  public static void clearPhaseHistory(Map<String, Object> updates, OverAllState state) {
    Map<String, Object> facts = fromState(state);
    facts.put(KEY_FAILED_DETAILS, List.of());
    facts.put(KEY_WRITTEN_FILES, List.of());
    putInUpdates(updates, facts);
  }

  public static boolean planPivot(OverAllState state) {
    return Boolean.TRUE.equals(fromState(state).get(KEY_PLAN_PIVOT));
  }

  /** True when a shell command family already failed this session (e.g. cmake missing). */
  public static boolean commandFamilyFailed(OverAllState state, String family) {
    if (state == null || family == null || family.isBlank()) {
      return false;
    }
    return stringList(fromState(state), KEY_FAILED_FAMILIES).contains(family);
  }

  public static List<String> primaryTargets(OverAllState state) {
    return stringList(fromState(state), KEY_PRIMARY_TARGETS);
  }

  /** LLM directive: session reality vs original plan (all task types). */
  public static String adaptationDirective(OverAllState state) {
    Map<String, Object> facts = fromState(state);
    if (!hasActionableFacts(facts)) {
      return "";
    }

    List<String> failed = stringList(facts, KEY_FAILED);
    List<String> successful = stringList(facts, KEY_SUCCESSFUL);
    List<String> targets = stringList(facts, KEY_PRIMARY_TARGETS);
    boolean pivot = Boolean.TRUE.equals(facts.get(KEY_PLAN_PIVOT));
    String summary = string(facts, KEY_PIVOT_SUMMARY);

    StringBuilder sb = new StringBuilder();
    sb.append("\n\n[SESSION EXECUTION FACTS — adapt this step to what actually happened]\n");
    sb.append(
        "The checklist was drafted before tools ran. Prefer these facts over stale plan paths, "
            + "commands, or assumptions from earlier steps.\n");
    if (!failed.isEmpty()) {
      sb.append("- Failed attempts (review before deciding next action):\n");
      for (String f : failed) {
        sb.append("  • ").append(f).append('\n');
      }
    }
    List<String> shellHistory = stringList(facts, KEY_FAILED_DETAILS);
    if (!shellHistory.isEmpty()) {
      sb.append("- Shell command history — evaluate each result to decide your next action:\n");
      for (String h : shellHistory) {
        // Format: "family|command|exitCode|ok|errorSnippet"
        String[] parts = h.split("\\|", 5);
        String family = parts.length > 0 ? parts[0] : "?";
        String cmd = parts.length > 1 ? parts[1] : "?";
        String exitCode = parts.length > 2 ? parts[2] : "?";
        String ok = parts.length > 3 ? parts[3] : "?";
        String err = parts.length > 4 ? parts[4] : "";
        sb.append("  • ").append(family).append(": `").append(cmd).append("` exit=").append(exitCode);
        if ("false".equals(ok) && !err.isEmpty()) {
          sb.append(" ✗ error=").append(err);
        } else if ("true".equals(ok)) {
          sb.append(" ✓");
        }
        sb.append('\n');
      }
      sb.append("  Decide your next action based on each command's result:\n");
      sb.append("  - Command failed to execute or produced errors: diagnose the cause from the error output, then either\n");
      sb.append("    switch to a different approach, or fix the underlying issue and retry with a modified command.\n");
      sb.append("  - Command succeeded but the output did not meet expectations: adjust the command parameters\n");
      sb.append("    (e.g., increase scope, change filters, use different options) or try a different approach.\n");
      sb.append("  - Command succeeded and goal met: proceed to the next step, do not rerun.\n");
      sb.append("  Do NOT repeat the exact same command that already failed — always modify it.\n");
    }
    if (!successful.isEmpty()) {
      sb.append("- Successful outcomes:\n");
      for (String s : successful) {
        sb.append("  • ").append(s).append('\n');
      }
    }
    if (!targets.isEmpty()) {
      sb.append("- Primary targets for remaining steps: ")
          .append(String.join(", ", targets))
          .append("\n");
    }
    if (pivot) {
      sb.append("- Plan pivot: strategy or path changed mid-session.\n");
      if (!summary.isBlank()) {
        sb.append("  ").append(summary).append('\n');
      }
      sb.append(
          "  Steps that still mention the old approach/path are outdated — use primary targets above.\n");
    }
    String resolved = resolvedStepAction(state);
    if (!resolved.isBlank()) {
      sb.append("- Resolved action for this step: ").append(resolved).append('\n');
    }
    List<String> written = writtenFiles(state);
    if (!written.isEmpty()) {
      sb.append("- Files already written this session (do NOT recreate with different content):\n");
      for (String path : written) {
        sb.append("  • ").append(path).append('\n');
      }
      sb.append(
          "  If the deliverable exists, use textOutput to confirm completion — do not emit patches "
              + "that rewrite these paths unless fixing a verify/repair failure.\n");
    }
    return sb.toString();
  }

  public static boolean allowWrittenFileOverwrite(OverAllState state) {
    return Boolean.TRUE.equals(state.value("allowWrittenFileOverwrite").orElse(false));
  }

  public static List<String> writtenFiles(OverAllState state) {
    return stringList(fromState(state), KEY_WRITTEN_FILES);
  }

  public static boolean hasWrittenOutputs(OverAllState state) {
    return !writtenFiles(state).isEmpty();
  }

  public static boolean isFileWritten(OverAllState state, String path) {
    if (path == null || path.isBlank()) {
      return false;
    }
    String norm = normalizePath(path);
    for (String written : writtenFiles(state)) {
      if (norm.equals(normalizePath(written))) {
        return true;
      }
    }
    return false;
  }

  public static void recordWrittenFile(Map<String, Object> facts, String path) {
    if (path == null || path.isBlank()) {
      return;
    }
    Set<String> written = new LinkedHashSet<>(stringList(facts, KEY_WRITTEN_FILES));
    written.add(normalizePath(path));
    facts.put(KEY_WRITTEN_FILES, new ArrayList<>(written));
  }

  public static void recordWrittenFiles(
      OverAllState state, Map<String, Object> updates, Iterable<String> paths) {
    Map<String, Object> facts = fromState(state);
    for (String path : paths) {
      recordWrittenFile(facts, path);
    }
    putInUpdates(updates, facts);
  }

  public static String resolvedStepAction(OverAllState state) {
    Map<String, Object> facts = fromState(state);
    String label = PhaseGoalHelper.currentStepLabel(state);
    List<String> targets = stringList(facts, KEY_PRIMARY_TARGETS);
    if (targets.isEmpty() && !planPivot(state)) {
      return "";
    }

    PhaseGoalHelper.StepKind kind = PhaseGoalHelper.inferStepKind(state);

    if (isObsoleteExploratoryStep(state, facts)) {
      return "This exploratory step targeted a failed approach; "
          + "use the successful outcome in [SESSION EXECUTION FACTS] and advance.";
    }

    if (stepAssumesStalePlan(label, facts)) {
      if (kind == PhaseGoalHelper.StepKind.RUN && !targets.isEmpty()) {
        return "Execute primary target `" + targets.get(0) + "` — plan path/command may be outdated.";
      }
      if ((kind == PhaseGoalHelper.StepKind.INSPECT || kind == PhaseGoalHelper.StepKind.PREPARE)
          && !targets.isEmpty()) {
        return "Inspect or verify `"
            + targets.get(0)
            + "` (and its directory) — earlier plan paths may no longer apply.";
      }
      if (!targets.isEmpty()) {
        return "Work on `"
            + targets.get(0)
            + "` per session facts; ignore obsolete plan wording.";
      }
    }

    if (kind == PhaseGoalHelper.StepKind.RUN && !targets.isEmpty()) {
      return "Run or verify `" + targets.get(0) + "` from actual session outcomes.";
    }

    return "";
  }

  /**
   * Generic inspect/prep step satisfaction: any tool type, respects plan pivots and primary targets.
   */
  public static boolean inspectGoalMet(OverAllState state, Map<String, Object> gathered) {
    if (gathered == null) {
      gathered = Map.of();
    }
    Map<String, Object> facts = fromState(state);
    String label = PhaseGoalHelper.currentStepLabel(state);

    if (isObsoleteExploratoryStep(state, facts)) {
      return true;
    }

    if (gathered.isEmpty()) {
      return false;
    }

    if (PhaseGoalHelper.inferStepKind(state) == PhaseGoalHelper.StepKind.RUN
        && !Boolean.TRUE.equals(state.value("sessionHadSuccessfulRun").orElse(false))) {
      return PhaseGoalHelper.hasSuccessfulRun(gathered);
    }

    if (stepAssumesStalePlan(label, facts)) {
      return gatheredCoversPrimaryTargets(facts, gathered);
    }

    if (PhaseGoalHelper.inferStepKind(state) == PhaseGoalHelper.StepKind.DISCOVER) {
      return PhaseGoalHelper.gatheredHasSuccessfulList(gathered);
    }
    return gatheredHasGenericInspect(gathered);
  }

  /** Block probes that follow stale plan paths after a pivot.
   *  Command-family-level blocking (failedFamilies) was previously used to hard-block retries,
   *  but this is too aggressive — it prevents the LLM from retrying with modified commands after
   *  fixing source code, using different flags, or reading more content. Instead, all failure
   *  details are now provided to the LLM via [SESSION EXECUTION FACTS] (see failedDetails),
   *  and the LLM decides whether a different approach can succeed. Only stale-path blocking
   *  (referencing files that no longer match the primary target) remains here. */
  public static java.util.Optional<String> staleProbeBlockReason(
      String command, OverAllState state) {
    if (command == null || command.isBlank()) {
      return java.util.Optional.empty();
    }
    // ★ Skip stale-path blocking when resuming from an askUser checkpoint.
    // After askUser resume, primaryTargets may be stale or incorrectly inferred
    // (e.g. phase rollback causes re-merge of directory listings that push
    // unrelated files to the top of primaryTargets). Blocking based on potentially
    // incorrect primaryTargets would prevent legitimate shell commands from running.
    String resumeNextNode = (String) state.value("resumeNextNode").orElse("");
    if (!resumeNextNode.isBlank()) {
      return java.util.Optional.empty();
    }
    // ★ Skip stale-path blocking during repair. Repair is explicitly trying to fix
    // previous failures — blocking its shell commands based on stale paths prevents
    // the repair from executing alternative approaches (e.g., retrying compilation
    // with different flags after source code has been fixed).
    String generateResult = (String) state.value("generateResult").orElse("");
    if ("repair".equals(generateResult)) {
      return java.util.Optional.empty();
    }
    Map<String, Object> facts = fromState(state);
    if (!planPivot(state)) {
      return java.util.Optional.empty();
    }

    String norm = ShellCommandGate.normalize(command);

    // NOTE: failedFamilies blocking is intentionally removed here. Previously, any command
    // whose family matched a previous failure was hard-blocked. This prevented the LLM from
    // retrying with modifications (e.g., fixed source, different flags, more content) that
    // could succeed. The LLM now receives full failure context in [SESSION EXECUTION FACTS]
    // and can decide for itself whether to retry, switch approach, or expand search scope.

    List<String> targets = stringList(facts, KEY_PRIMARY_TARGETS);
    if (targets.isEmpty()) {
      return java.util.Optional.empty();
    }
    String primary = targets.get(0);
    Set<String> stalePaths = stalePathTokens(facts, labelFromState(state));
    for (String stale : stalePaths) {
      if (norm.contains(stale) && !referencesTarget(norm, primary)) {
        return java.util.Optional.of(
            "Skipped: plan assumed `"
                + stale
                + "` but session primary target is `"
                + primary
                + "`.");
      }
    }
    return java.util.Optional.empty();
  }

  // ── merge / record ───────────────────────────────────────────────────────

  @SuppressWarnings("unchecked")
  private static void mergeGatheredInto(Map<String, Object> facts, Map<String, Object> gathered) {
    Set<String> failed = new LinkedHashSet<>(stringList(facts, KEY_FAILED));
    Set<String> successful = new LinkedHashSet<>(stringList(facts, KEY_SUCCESSFUL));
    Set<String> targets = new LinkedHashSet<>(stringList(facts, KEY_PRIMARY_TARGETS));
    Set<String> touched = new LinkedHashSet<>(stringList(facts, KEY_TOUCHED_PATHS));
    Set<String> failedFamilies = new LinkedHashSet<>(stringList(facts, KEY_FAILED_FAMILIES));
    Set<String> successFamilies = new LinkedHashSet<>(stringList(facts, KEY_SUCCESSFUL_FAMILIES));
    List<String> failedDetails = new ArrayList<>(stringList(facts, KEY_FAILED_DETAILS));
    String priorSuccessFamily = successFamilies.isEmpty() ? "" : successFamilies.iterator().next();

    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      String kind = String.valueOf(entry.get("kind"));
      boolean ok = GatheredInfoFormatter.entrySucceeded(entry);

      if ("fs.list".equals(kind) || "fs.read".equals(kind)) {
        String path = pathFromResult(entry);
        if (!path.isBlank()) {
          touched.add(path);
          if (ok) {
            successful.add(kind + ": " + path);
          } else {
            String err = stringOr(entry.get("errorMessage"), stringOr(entry.get("error"), "failed"));
            failed.add(kind + ": " + path + " — " + err);
          }
        }
        if ("fs.list".equals(kind) && ok) {
          absorbListedFilePathsFromList(entry, targets);
        }
        continue;
      }

      if (!"shell.exec".equals(kind)) {
        if (ok) {
          successful.add(kind + " (" + entry.getOrDefault("id", "") + ")");
        } else {
          failed.add(kind + ": " + stringOr(entry.get("errorMessage"), "failed"));
        }
        continue;
      }

      String cmd = shellCommand(entry);
      if (cmd.isBlank()) {
        continue;
      }
      String family = commandFamily(cmd);
      if (!ok) {
        failed.add(truncate(cmd, 120));
        if (!family.isBlank()) {
          failedFamilies.add(family);
        }
      }
      // Record ALL shell results (both success and failure) in shellHistory so the LLM
      // has full context to decide next action. This covers:
      //   - Tool-missing (exit!=0): LLM may switch to an alternative command
      //   - Compilation/runtime error (exit!=0): LLM may fix source and retry
      //   - Successful but unsatisfied (exit=0, e.g. tail -n 10 found nothing):
      //     LLM may expand scope (more lines, broader search)
      //   - Successful and satisfied (exit=0): LLM knows this worked
      int exitCode = exitCodeFromEntry(entry);
      String errSnippet = ok ? "" : truncate(stringOr(entry.get("errorMessage"), "exit=" + exitCode), 120);
      failedDetails.add(family + "|" + truncate(cmd, 80) + "|" + exitCode + "|" + ok + "|" + errSnippet);

      if (!ok) {
        continue;
      }

      successful.add(truncate(cmd, 120));
      if (!family.isBlank()) {
        if (!priorSuccessFamily.isBlank()
            && !priorSuccessFamily.equals(family)
            && !failedFamilies.isEmpty()) {
          markPlanPivot(facts, priorSuccessFamily, family, cmd, targets);
        }
        successFamilies.add(family);
        priorSuccessFamily = family;
      }

      extractTargetsFromCommand(cmd, targets);
      if (PhaseGoalHelper.looksLikeProgramExecution(cmd)) {
        targets.add(extractRunTarget(cmd));
      }
      for (String token : pathTokens(cmd)) {
        touched.add(token);
      }
    }

    facts.put(KEY_FAILED, new ArrayList<>(failed));
    facts.put(KEY_SUCCESSFUL, new ArrayList<>(successful));
    facts.put(KEY_PRIMARY_TARGETS, new ArrayList<>(targets));
    facts.put(KEY_TOUCHED_PATHS, new ArrayList<>(touched));
    facts.put(KEY_FAILED_FAMILIES, new ArrayList<>(failedFamilies));
    facts.put(KEY_SUCCESSFUL_FAMILIES, new ArrayList<>(successFamilies));
    facts.put(KEY_FAILED_DETAILS, new ArrayList<>(failedDetails));

    detectReadPathMismatchPivot(facts, gathered, targets);

    if (!Boolean.TRUE.equals(facts.get(KEY_PLAN_PIVOT))) {
      detectPivotFromFailures(facts, failedFamilies, successFamilies, targets);
    }
  }

  private static void markPlanPivot(
      Map<String, Object> facts,
      String fromFamily,
      String toFamily,
      String lastCmd,
      Set<String> targets) {
    facts.put(KEY_PLAN_PIVOT, true);
    String targetHint =
        targets.isEmpty() ? "" : " → use " + String.join(", ", targets);
    facts.put(
        KEY_PIVOT_SUMMARY,
        "Approach changed: `"
            + fromFamily
            + "` failed earlier; `"
            + toFamily
            + "` succeeded"
            + targetHint
            + ".");
  }

  private static void detectPivotFromFailures(
      Map<String, Object> facts,
      Set<String> failedFamilies,
      Set<String> successFamilies,
      Set<String> targets) {
    if (failedFamilies.isEmpty() || successFamilies.isEmpty()) {
      return;
    }
    for (String ok : successFamilies) {
      if (failedFamilies.contains(ok)) {
        continue;
      }
      for (String bad : failedFamilies) {
        if (!bad.equals(ok)) {
          facts.put(KEY_PLAN_PIVOT, true);
          String targetHint =
              targets.isEmpty() ? "" : " Primary: " + String.join(", ", targets);
          facts.put(
              KEY_PIVOT_SUMMARY,
              "`" + bad + "` failed; `" + ok + "` succeeded." + targetHint);
          return;
        }
      }
    }
  }

  // ── step / plan analysis (domain-agnostic) ───────────────────────────────

  private static boolean stepAssumesStalePlan(String stepLabel, Map<String, Object> facts) {
    if (!Boolean.TRUE.equals(facts.get(KEY_PLAN_PIVOT))) {
      return false;
    }
    Set<String> stepTokens = pathTokens(stepLabel);
    if (stepTokens.isEmpty()) {
      return false;
    }
    Set<String> stale = stalePathTokens(facts, stepLabel);
    if (stale.isEmpty()) {
      return false;
    }
    List<String> targets = stringList(facts, KEY_PRIMARY_TARGETS);
    for (String t : stepTokens) {
      if (stale.contains(t)
          && targets.stream().noneMatch(p -> p.contains(t) || t.contains(p.replace("./", "")))) {
        return true;
      }
    }
    return false;
  }

  /**
   * After a plan pivot, skip redundant discover/inspect/prepare steps that targeted a failed
   * approach. Uses structured {@link PhaseGoalHelper#inferStepKind}, not title keywords.
   */
  private static boolean isObsoleteExploratoryStep(OverAllState state, Map<String, Object> facts) {
    PhaseGoalHelper.StepKind kind = PhaseGoalHelper.inferStepKind(state);
    if (!isExploratoryStepKind(kind)) {
      return false;
    }
    String label = PhaseGoalHelper.currentStepLabel(state);
    List<String> failedFamilies = stringList(facts, KEY_FAILED_FAMILIES);
    List<String> okFamilies = stringList(facts, KEY_SUCCESSFUL_FAMILIES);
    if (failedFamilies.isEmpty() || okFamilies.isEmpty()) {
      return false;
    }
    for (String token : pathTokens(label)) {
      for (String ff : failedFamilies) {
        if (token.contains(ff) || ff.contains(token)) {
          return !stringList(facts, KEY_PRIMARY_TARGETS).isEmpty();
        }
      }
    }
    for (String ff : failedFamilies) {
      if (label.toLowerCase().contains(ff.toLowerCase())) {
        return !stringList(facts, KEY_PRIMARY_TARGETS).isEmpty();
      }
    }
    return false;
  }

  private static boolean isExploratoryStepKind(PhaseGoalHelper.StepKind kind) {
    return kind == PhaseGoalHelper.StepKind.DISCOVER
        || kind == PhaseGoalHelper.StepKind.INSPECT
        || kind == PhaseGoalHelper.StepKind.PREPARE;
  }

  private static Set<String> stalePathTokens(Map<String, Object> facts, String stepLabel) {
    Set<String> stale = new LinkedHashSet<>();
    for (String f : stringList(facts, KEY_FAILED)) {
      stale.addAll(pathTokens(f));
    }
    Set<String> primary = new LinkedHashSet<>(stringList(facts, KEY_PRIMARY_TARGETS));
    stale.removeIf(
        t -> primary.stream().anyMatch(p -> p.contains(t) || t.contains(p.replace("./", ""))));
    return stale;
  }

  private static String labelFromState(OverAllState state) {
    return PhaseGoalHelper.currentStepLabel(state);
  }

  // ── gathered coverage ────────────────────────────────────────────────────

  @SuppressWarnings("unchecked")
  private static boolean gatheredCoversPrimaryTargets(
      Map<String, Object> facts, Map<String, Object> gathered) {
    List<String> targets = stringList(facts, KEY_PRIMARY_TARGETS);
    if (targets.isEmpty()) {
      return gatheredHasGenericInspect(gathered);
    }
    for (String target : targets) {
      if (gatheredReferencesPath(gathered, target)
          || gatheredReferencesPath(gathered, parentPath(target))) {
        return true;
      }
    }
    return PhaseGoalHelper.hasSuccessfulRun(gathered);
  }

  @SuppressWarnings("unchecked")
  private static boolean gatheredReferencesPath(Map<String, Object> gathered, String path) {
    if (path == null || path.isBlank()) {
      return false;
    }
    String norm = path.replace('\\', '/').replaceAll("^\\./", "");
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)
          || !GatheredInfoFormatter.entrySucceeded((Map<String, Object>) raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      String kind = String.valueOf(entry.get("kind"));
      if ("fs.list".equals(kind) || "fs.read".equals(kind)) {
        String p = pathFromResult(entry).replace('\\', '/').replaceAll("^\\./", "");
        if (p.equals(norm) || norm.startsWith(p + "/") || p.startsWith(norm)) {
          return true;
        }
      }
      if ("shell.exec".equals(kind)) {
        String cmd = shellCommand(entry);
        if (cmd.contains(path) || cmd.contains(norm)) {
          return true;
        }
      }
    }
    return false;
  }

  @SuppressWarnings("unchecked")
  private static boolean gatheredHasGenericInspect(Map<String, Object> gathered) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      String kind = String.valueOf(entry.get("kind"));
      if ("fs.read".equals(kind)) {
        return true;
      }
    }
    return false;
  }

  // ── command / path helpers ───────────────────────────────────────────────

  static String commandFamily(String cmd) {
    if (cmd == null || cmd.isBlank()) {
      return "";
    }
    String lower = cmd.toLowerCase();
    if (lower.contains("cmake")) {
      return "cmake";
    }
    if (lower.contains("g++") || lower.contains("clang++")) {
      return "g++";
    }
    if (lower.matches(".*\\bmake\\b.*")) {
      return "make";
    }
    if (lower.contains("gradle")) {
      return "gradle";
    }
    if (lower.contains("mvn")) {
      return "maven";
    }
    if (lower.contains("npm") || lower.contains("pnpm") || lower.contains("yarn")) {
      return "npm";
    }
    if (lower.contains("pytest") || lower.contains("python -m pytest")) {
      return "pytest";
    }
    if (lower.contains("docker")) {
      return "docker";
    }
    if (lower.contains("kubectl")) {
      return "kubectl";
    }
    if (lower.contains("cargo")) {
      return "cargo";
    }
    if (lower.contains("go test") || lower.startsWith("go ")) {
      return "go";
    }
    if (lower.contains("curl") || lower.contains("wget")) {
      return "http";
    }
    String[] parts = lower.split("\\s+");
    return parts.length > 0 ? parts[0] : "";
  }

  private static void extractTargetsFromCommand(String cmd, Set<String> targets) {
    Matcher m = SHELL_OUTPUT_FLAG.matcher(cmd);
    if (m.find()) {
      targets.add(normalizePath(m.group(1)));
    }
    for (String token : pathTokens(cmd)) {
      if (token.contains(".") || token.endsWith("/")) {
        targets.add(token);
      }
    }
  }

  private static String extractRunTarget(String cmd) {
    String t = cmd.trim();
    int idx = t.indexOf("./");
    if (idx >= 0) {
      int end = idx + 2;
      while (end < t.length() && !Character.isWhitespace(t.charAt(end))) {
        end++;
      }
      return t.substring(idx, end);
    }
    return t;
  }

  private static Set<String> pathTokens(String text) {
    Set<String> out = new LinkedHashSet<>();
    if (text == null || text.isBlank()) {
      return out;
    }
    Matcher m = PATH_IN_TEXT.matcher(text);
    while (m.find()) {
      out.add(m.group().replace('\\', '/'));
    }
    return out;
  }

  private static String normalizePath(String path) {
    String p = path.trim();
    if (p.startsWith("./") || p.startsWith("/")) {
      return p;
    }
    return "./" + p;
  }

  private static boolean referencesTarget(String command, String target) {
    return command.contains(target) || command.contains(target.replace("./", ""));
  }

  private static boolean hasActionableFacts(Map<String, Object> facts) {
    return !stringList(facts, KEY_FAILED).isEmpty()
        || !stringList(facts, KEY_SUCCESSFUL).isEmpty()
        || !stringList(facts, KEY_PRIMARY_TARGETS).isEmpty()
        || Boolean.TRUE.equals(facts.get(KEY_PLAN_PIVOT));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> migrateLegacyKeys(Map<String, Object> facts) {
    if (Boolean.TRUE.equals(facts.get(LEGACY_BUILD_PIVOT))) {
      facts.put(KEY_PLAN_PIVOT, true);
    }
    Object ob = facts.get("outputBinaries");
    if (ob instanceof List<?> list && !list.isEmpty()) {
      Set<String> targets = new LinkedHashSet<>(stringList(facts, KEY_PRIMARY_TARGETS));
      for (Object o : list) {
        if (o != null) {
          targets.add(o.toString());
        }
      }
      facts.put(KEY_PRIMARY_TARGETS, new ArrayList<>(targets));
    }
    Object fa = facts.get("failedApproaches");
    if (fa instanceof List<?> list && !list.isEmpty()) {
      Set<String> failed = new LinkedHashSet<>(stringList(facts, KEY_FAILED));
      for (Object o : list) {
        if (o != null) {
          failed.add(o.toString());
        }
      }
      facts.put(KEY_FAILED, new ArrayList<>(failed));
    }
    return facts;
  }

  // ── shared utilities ─────────────────────────────────────────────────────

  /**
   * Re-prioritize primaryTargets so that files modified in the current session
   * (from "modifiedFiles" state key) appear first. This prevents unrelated files
   * discovered from directory listings (e.g. LRU.h) from being treated as the
   * primary target when the user is actually working on a different file
   * (e.g. leetcode42.cpp).
   */
  @SuppressWarnings("unchecked")
  private static void reprioritizeTargetsFromModifiedFiles(
      OverAllState state, Map<String, Object> facts) {
    Object modifiedRaw = state.value("modifiedFiles").orElse(null);
    if (modifiedRaw == null) {
      return;
    }
    Set<String> modified;
    if (modifiedRaw instanceof List<?> list) {
      modified = new LinkedHashSet<>();
      for (Object item : list) {
        if (item != null) {
          modified.add(item.toString().replace('\\', '/').replaceAll("^\\./", ""));
        }
      }
    } else if (modifiedRaw instanceof Set<?> set) {
      modified = new LinkedHashSet<>();
      for (Object item : set) {
        if (item != null) {
          modified.add(item.toString().replace('\\', '/').replaceAll("^\\./", ""));
        }
      }
    } else {
      return;
    }
    if (modified.isEmpty()) {
      return;
    }
    List<String> currentTargets = stringList(facts, KEY_PRIMARY_TARGETS);
    if (currentTargets.isEmpty()) {
      return;
    }
    // Build reordered list: modified files first (in order), then remaining targets
    List<String> reordered = new ArrayList<>();
    Set<String> added = new LinkedHashSet<>();
    for (String modFile : modified) {
      for (String target : currentTargets) {
        String normTarget = target.replace('\\', '/').replaceAll("^\\./", "");
        if (!added.contains(target) && (normTarget.equals(modFile) || normTarget.startsWith(modFile.replace(".h", "").replace(".cpp", "")))) {
          reordered.add(target);
          added.add(target);
        }
      }
    }
    // Also add modified files that are not yet in targets
    for (String modFile : modified) {
      String withPrefix = "./" + modFile;
      if (!added.contains(modFile) && !added.contains(withPrefix)) {
        reordered.add(0, withPrefix);
        added.add(withPrefix);
      }
    }
    // Add remaining targets that were not modified
    for (String target : currentTargets) {
      if (!added.contains(target)) {
        reordered.add(target);
      }
    }
    if (!reordered.equals(currentTargets)) {
      facts.put(KEY_PRIMARY_TARGETS, reordered);
    }
  }

  /** Record file paths from a successful directory listing (extension-based, capped). */
  @SuppressWarnings("unchecked")
  private static void absorbListedFilePathsFromList(
      Map<String, Object> entry, Set<String> targets) {
    Object result = entry.get("result");
    if (!(result instanceof Map<?, ?> raw)) {
      return;
    }
    Object entries = ((Map<String, Object>) raw).get("entries");
    if (!(entries instanceof List<?> list)) {
      return;
    }
    String base = pathFromResult(entry).replace('\\', '/').replaceAll("^\\./", "");
    int added = 0;
    for (Object item : list) {
      if (added >= MAX_TARGETS_FROM_LIST) {
        break;
      }
      if (!(item instanceof Map<?, ?> ent)) {
        continue;
      }
      Map<String, Object> em = (Map<String, Object>) ent;
      if (!"file".equals(String.valueOf(em.getOrDefault("type", "")))) {
        continue;
      }
      String name = String.valueOf(em.getOrDefault("name", "")).trim();
      if (name.isBlank() || !SOURCE_FILE_EXT.matcher(name).matches()) {
        continue;
      }
      String full = base.isBlank() ? name : base + "/" + name;
      targets.add(normalizeListedPath(full));
      added++;
    }
  }

  /**
   * When many reads under directory D fail but listings discovered source files outside D,
   * record a plan pivot so later steps use discovered paths instead of stale plan assumptions.
   */
  @SuppressWarnings("unchecked")
  private static void detectReadPathMismatchPivot(
      Map<String, Object> facts, Map<String, Object> gathered, Set<String> targets) {
    Map<String, Integer> failedReadsByDir = failedReadCountsByParentDir(gathered);
    if (failedReadsByDir.isEmpty() || targets.isEmpty()) {
      return;
    }
    String hotFailedDir =
        failedReadsByDir.entrySet().stream()
            .filter(e -> e.getValue() >= 2)
            .map(Map.Entry::getKey)
            .findFirst()
            .orElse(null);
    if (hotFailedDir == null) {
      return;
    }
    List<String> alternates =
        targets.stream()
            .filter(t -> looksLikeSourceFile(t) && !isUnderDirectory(t, hotFailedDir))
            .limit(3)
            .toList();
    if (alternates.isEmpty()) {
      return;
    }
    facts.put(KEY_PLAN_PIVOT, true);
    facts.put(
        KEY_PIVOT_SUMMARY,
        "Multiple fs.read attempts under `"
            + hotFailedDir
            + "` failed (paths not found). "
            + "Use files discovered from successful fs.list — e.g. `"
            + alternates.get(0)
            + "`.");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Integer> failedReadCountsByParentDir(Map<String, Object> gathered) {
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!"fs.read".equals(String.valueOf(entry.get("kind")))
          || GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      String path = pathFromResult(entry).replace('\\', '/').replaceAll("^\\./", "");
      if (path.isBlank()) {
        continue;
      }
      String dir = parentDirectory(path);
      counts.merge(dir, 1, Integer::sum);
    }
    return counts;
  }

  private static boolean looksLikeSourceFile(String path) {
    if (path == null || path.isBlank()) {
      return false;
    }
    String name = path.replace('\\', '/');
    int slash = name.lastIndexOf('/');
    if (slash >= 0) {
      name = name.substring(slash + 1);
    }
    return SOURCE_FILE_EXT.matcher(name).matches();
  }

  private static boolean isUnderDirectory(String path, String directory) {
    if (path == null || directory == null || directory.isBlank()) {
      return false;
    }
    String normPath = path.replace('\\', '/').replaceAll("^\\./", "");
    String normDir = directory.replace('\\', '/').replaceAll("^\\./", "").replaceAll("/$", "");
    if (normDir.isEmpty() || ".".equals(normDir)) {
      return !normPath.contains("/");
    }
    return normPath.equals(normDir) || normPath.startsWith(normDir + "/");
  }

  private static String parentDirectory(String path) {
    String p = path.replace('\\', '/').replaceAll("^\\./", "");
    int slash = p.lastIndexOf('/');
    if (slash <= 0) {
      return ".";
    }
    return p.substring(0, slash);
  }

  private static String normalizeListedPath(String path) {
    return path.replace('\\', '/').replaceAll("^\\./", "");
  }

  private static String pathFromResult(Map<String, Object> entry) {
    Object result = entry.get("result");
    if (result instanceof Map<?, ?> m) {
      Object path = m.get("path");
      return path != null ? path.toString() : "";
    }
    return "";
  }

  private static String shellCommand(Map<String, Object> entry) {
    Object result = entry.get("result");
    if (result instanceof Map<?, ?> shell) {
      Object cmd = shell.get("command");
      return cmd != null ? cmd.toString() : "";
    }
    return "";
  }

  private static String parentPath(String path) {
    String p = path.replace('\\', '/');
    int slash = p.lastIndexOf('/');
    if (slash <= 0) {
      return ".";
    }
    return p.substring(0, slash);
  }

  private static String truncate(String s, int max) {
    return s.length() <= max ? s : s.substring(0, max) + "…";
  }

  private static String string(Map<String, Object> map, String key) {
    Object v = map.get(key);
    return v != null ? v.toString().trim() : "";
  }

  private static String stringOr(Object o, String def) {
    return o != null && !o.toString().isBlank() ? o.toString().trim() : def;
  }

  private static List<String> stringList(Map<String, Object> map, String key) {
    Object v = map.get(key);
    if (v instanceof List<?> list) {
      List<String> out = new ArrayList<>();
      for (Object o : list) {
        if (o != null && !o.toString().isBlank()) {
          out.add(o.toString());
        }
      }
      return out;
    }
    return List.of();
  }

  /** Extract exit code from a gathered shell.exec entry's result map. */
  private static int exitCodeFromEntry(Map<String, Object> entry) {
    Object result = entry.get("result");
    if (result instanceof Map<?, ?> m) {
      Object ec = m.get("exitCode");
      if (ec instanceof Number n) {
        return n.intValue();
      }
      if (ec != null) {
        try { return Integer.parseInt(ec.toString()); } catch (NumberFormatException ignored) {}
      }
    }
    return -1; // unknown
  }

}
