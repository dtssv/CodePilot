package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Detects whether the <em>current plan step's goal</em> is already satisfied in gathered tool
 * results. Step classification uses structured {@code phases[].intent} (and optional
 * {@code userPlan.steps[].intent}) — not natural-language keyword matching on titles.
 */
public final class PhaseGoalHelper {

  /**
   * Shell command shape: build tools (language-agnostic command tokens, not plan titles).
   * Must appear at command start or after a pipe / logical-operator so that probe commands
   * like {@code which g++}, {@code type clang++}, {@code echo g++} are NOT matched.
   */
  private static final Pattern COMPILE_CMD =
      Pattern.compile(
          "(?i)(?:^|[|&;]{1,2}\\s*)"
              + "(?:g\\+\\+|clang\\+\\+|cmake\\s+--build|\\bmake\\b|mvn\\s|gradle\\s|npm\\s+run\\s+build|cargo\\s+build)");
  /** Shell command shape: executing a built artifact path. */
  private static final Pattern RUN_CMD =
      Pattern.compile(
          "(?i)(^|[;&|]\\s*)(\\./[^\\s'\"]+|build/[^\\s'\"]+/[^\\s'\"]+|build/[^\\s'\"]+$)");
  /** Source file extensions for analysis deliverables (path structure, not prose). */
  private static final Pattern SOURCE_FILE =
      Pattern.compile("(?i)\\.(cpp|cc|c|h|hpp|java|py|go|rs|ts|js|kt|rb|cs|swift)$");

  /** Source path in user input (IDE context lines may include {@code :line} suffix). */
  private static final Pattern SOURCE_FILE_IN_INPUT =
      Pattern.compile(
          "(?i)[\\w./\\-]+\\.(cpp|cc|c|h|hpp|java|py|go|rs|ts|js|kt|rb|cs|swift)(?:\\s*:\\s*\\d+)?\\b");

  private PhaseGoalHelper() {}

  /** Step kinds aligned with planner {@code phases[].intent} slugs. */
  public enum StepKind {
    COMPILE,
    RUN,
    /** Compile-then-run verification step: both compile and run must succeed. */
    VERIFY,
    ANALYZE,
    INSPECT,
    PREPARE,
    DISCOVER,
    /** Format / report / deliver markdown after reads completed in an earlier step. */
    SYNTHESIZE,
    GENERIC
  }

  /**
   * Canonical intent slugs the planner should emit (see graph.planning.txt). Aliases are normalized
   * in {@link #mapIntentSlug(String)}.
   */
  public static final String INTENT_COMPILE = "compile";
  public static final String INTENT_RUN = "run";
  /** Compile + run verification (e.g. "compile-verify", "test", "validate"). */
  public static final String INTENT_VERIFY = "verify";
  public static final String INTENT_ANALYZE = "analyze";
  public static final String INTENT_INSPECT = "inspect";
  public static final String INTENT_PREPARE = "prepare";
  public static final String INTENT_DISCOVER = "discover";
  public static final String INTENT_SYNTHESIZE = "synthesize";
  public static final String INTENT_CODE_CHANGE = "code-change";

  /**
   * After this many generate passes on a COMPILE/RUN/VERIFY step, allow phase commit even if shell tools
   * failed — avoids infinite generate↔commit loops when the environment cannot compile (e.g. no
   * cmake) but the agent already delivered files (tests, fixes).
   *
   * <p>Reduced from 8 to 5: each retry accumulates prompt history (growing from ~27k to ~43k chars),
   * wasting ~25k tokens per retry. 5 retries is enough to try alternative approaches before
   * advancing with overallGoalUnmet.
   */
  public static final int STUCK_COMPILE_RUN_PASS_THRESHOLD = 5;

  @SuppressWarnings("unchecked")
  public static boolean currentStepGoalSatisfied(OverAllState state) {
    Map<String, Object> gathered =
        (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
    return currentStepGoalSatisfied(state, gathered);
  }

  /** Same as {@link #currentStepGoalSatisfied(OverAllState)} but uses a pending gathered map. */
  public static boolean currentStepGoalSatisfied(
      OverAllState state, Map<String, Object> gathered) {
    if (gathered == null) {
      gathered = Map.of();
    }
    StepKind kind = inferStepKind(state);
    // ANALYZE/SYNTHESIZE can complete from IDE selection or pasted snippets in user input
    // without fs.read entries in gatheredInfo.
    if (gathered.isEmpty()) {
      return switch (kind) {
        case ANALYZE -> analyzeGoalMet(state, gathered);
        case SYNTHESIZE -> synthesizeGoalMet(state);
        case INSPECT -> inspectGoalMet(state, gathered);
        // VERIFY needs both compile AND run results; cannot be satisfied with empty gathered
        case VERIFY, COMPILE, RUN -> false;
        default -> false;
      };
    }
    return switch (kind) {
      case COMPILE -> hasSuccessfulCompile(gathered);
      case RUN -> hasSuccessfulRun(gathered);
      case VERIFY -> hasSuccessfulCompile(gathered) && hasSuccessfulRun(gathered);
      case ANALYZE -> analyzeGoalMet(state, gathered);
      case INSPECT -> inspectGoalMet(state, gathered);
      case PREPARE -> hasSuccessfulPrepare(gathered) || hasSuccessfulCompile(gathered);
      case DISCOVER -> discoverGoalMet(state, gathered);
      case SYNTHESIZE -> synthesizeGoalMet(state);
      case GENERIC -> hasSuccessfulCompile(gathered) || hasSuccessfulRun(gathered);
    };
  }

  public static boolean overallCompileRunGoalMet(OverAllState state) {
    if (!sessionExpectsCompileRunWorkflow(state)) {
      return true;
    }
    boolean compiled =
        Boolean.TRUE.equals(state.value("sessionHadSuccessfulCompile").orElse(false));
    boolean ran = Boolean.TRUE.equals(state.value("sessionHadSuccessfulRun").orElse(false));
    return compiled && ran;
  }

  /**
   * COMPILE/RUN steps with failed shell tools normally block commit; after enough retries or when
   * deliverable files were written, advance the plan with {@code overallGoalUnmet} instead of looping.
   */
  public static boolean shouldAdvanceCompileRunDespiteToolFailures(OverAllState state) {
    StepKind kind = inferStepKind(state);
    if (kind != StepKind.COMPILE && kind != StepKind.RUN && kind != StepKind.VERIFY) {
      return false;
    }
    if (currentStepGoalSatisfied(state)) {
      return false;
    }
    int passes = (int) state.value("phaseGeneratePasses").orElse(0);
    if (passes >= STUCK_COMPILE_RUN_PASS_THRESHOLD) {
      return true;
    }
    return (kind == StepKind.COMPILE || kind == StepKind.VERIFY)
        && SessionExecutionFacts.hasWrittenOutputs(state);
  }

  public static void recordSessionMilestones(
      Map<String, Object> updates, Map<String, Object> gathered) {
    if (hasSuccessfulCompile(gathered)) {
      updates.put("sessionHadSuccessfulCompile", true);
    }
    if (hasSuccessfulRun(gathered)) {
      updates.put("sessionHadSuccessfulRun", true);
    }
  }

  /**
   * For VERIFY steps: record session milestones from the combined gathered info,
   * and also set a session-level flag so the workflow position inference can
   * correctly detect that compile has been done (even if run has not).
   */
  public static void recordVerifySessionMilestones(
      OverAllState state, Map<String, Object> updates, Map<String, Object> gathered) {
    recordSessionMilestones(updates, gathered);
    // If this is a VERIFY step and compile succeeded but run did not,
    // mark the workflow position so next iteration infers RUN (not COMPILE again).
    StepKind kind = inferStepKind(state);
    if (kind == StepKind.VERIFY && hasSuccessfulCompile(gathered) && !hasSuccessfulRun(gathered)) {
      updates.put("sessionHadSuccessfulCompile", true);
    }
  }

  /**
   * Resolve step kind from structured plan metadata first, then session workflow position, then
   * GENERIC. Never matches free-text step titles.
   *
   * <p>Important: when the current phase has an explicit code-change intent (meaning it is a
   * code modification step, not a compile/run step), the workflow-based inference should NOT
   * override it to COMPILE/RUN. This prevents the commit loop where a code-change phase
   * is incorrectly forced to satisfy a compile goal before advancing.
   */
  public static StepKind inferStepKind(OverAllState state) {
    StepKind fromPhase = stepKindFromIntentField(currentPhaseIntent(state));
    if (fromPhase != null) {
      return fromPhase;
    }
    StepKind fromStep = stepKindFromIntentField(currentUserStepIntent(state));
    if (fromStep != null) {
      return fromStep;
    }
    // When the phase intent is explicitly code-change, the phase's job is to produce
    // patches — compile/run verification belongs to a later phase. Do NOT let the
    // workflow inference override code-change to COMPILE/RUN.
    if (isCodeChangePhase(state)) {
      return StepKind.GENERIC;
    }
    StepKind fromWorkflow = stepKindFromCompileRunWorkflow(state);
    if (fromWorkflow != null) {
      return fromWorkflow;
    }
    return StepKind.GENERIC;
  }

  /** Returns true when the current phase intent indicates a code modification step. */
  static boolean isCodeChangePhase(OverAllState state) {
    String phaseIntent = normalizeIntentSlug(currentPhaseIntent(state));
    if (INTENT_CODE_CHANGE.equals(phaseIntent) || "implement".equals(phaseIntent)
        || "code".equals(phaseIntent) || "refactor".equals(phaseIntent)) {
      return true;
    }
    String stepIntent = normalizeIntentSlug(currentUserStepIntent(state));
    return INTENT_CODE_CHANGE.equals(stepIntent) || "implement".equals(stepIntent)
        || "code".equals(stepIntent) || "refactor".equals(stepIntent);
  }

  /** Normalize planner / API intent strings to a canonical slug. */
  public static String normalizeIntentSlug(String raw) {
    if (raw == null || raw.isBlank()) {
      return "";
    }
    return raw.trim().toLowerCase(Locale.ROOT).replace('_', '-').replace(' ', '-');
  }

  static StepKind stepKindFromIntentField(String intentSlug) {
    String slug = normalizeIntentSlug(intentSlug);
    if (slug.isEmpty()) {
      return null;
    }
    return mapIntentSlug(slug);
  }

  static StepKind mapIntentSlug(String slug) {
    return switch (slug) {
      case INTENT_COMPILE, "build", "build-project" -> StepKind.COMPILE;
      case INTENT_RUN, "execute", "run-program" -> StepKind.RUN;
      case INTENT_VERIFY, "compile-verify", "test", "validate", "compile-and-test",
          "compile-test", "compile-run" -> StepKind.VERIFY;
      case INTENT_ANALYZE, "analysis", "review", "explain" -> StepKind.ANALYZE;
      case INTENT_SYNTHESIZE, "report", "format", "summarize", "document", "deliver" ->
          StepKind.SYNTHESIZE;
      // "verify" as a read-only inspection maps to INSPECT; for compile+run verification
      // planners should use "compile-verify" or "test" instead.
      case INTENT_INSPECT, "read", "check" -> StepKind.INSPECT;
      case INTENT_PREPARE, "configure", "setup", "config" -> StepKind.PREPARE;
      case INTENT_DISCOVER, "list", "enumerate", "scan" -> StepKind.DISCOVER;
      case INTENT_CODE_CHANGE, "generic", "implement", "code" -> null;
      default -> null;
    };
  }

  @SuppressWarnings("unchecked")
  static String currentPhaseIntent(OverAllState state) {
    Map<String, Object> phase = currentPhase(state);
    if (phase == null) {
      return "";
    }
    return String.valueOf(phase.getOrDefault("intent", ""));
  }

  @SuppressWarnings("unchecked")
  static String currentUserStepIntent(OverAllState state) {
    Map<String, Object> step = currentUserStep(state);
    if (step == null) {
      return "";
    }
    return String.valueOf(step.getOrDefault("intent", ""));
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> currentPhase(OverAllState state) {
    String phaseId = (String) state.value("phaseCursor").orElse("");
    if (phaseId.isBlank()) {
      return null;
    }
    List<Map<String, Object>> phases =
        (List<Map<String, Object>>) state.value("phases").orElse(List.of());
    for (Map<String, Object> phase : phases) {
      if (phaseId.equals(String.valueOf(phase.get("id")))) {
        return phase;
      }
    }
    return null;
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> currentUserStep(OverAllState state) {
    int stepIdx = UserPlanProgressHelper.currentStepIndex(state);
    if (stepIdx < 0) {
      return null;
    }
    Map<String, Object> userPlan =
        (Map<String, Object>) state.value("userPlan").orElse(Map.of());
    List<Map<String, Object>> steps =
        (List<Map<String, Object>>) userPlan.getOrDefault("steps", List.of());
    if (stepIdx >= steps.size()) {
      return null;
    }
    return steps.get(stepIdx);
  }

  /**
   * When intake/planning marked a compile→run workflow but phases still use generic intent, infer
   * the active milestone from session progress (not from user message keywords).
   */
  static StepKind stepKindFromCompileRunWorkflow(OverAllState state) {
    if (!sessionExpectsCompileRunWorkflow(state)) {
      return null;
    }
    boolean compiled =
        Boolean.TRUE.equals(state.value("sessionHadSuccessfulCompile").orElse(false));
    if (!compiled) {
      return StepKind.COMPILE;
    }
    boolean ran = Boolean.TRUE.equals(state.value("sessionHadSuccessfulRun").orElse(false));
    if (!ran) {
      return StepKind.RUN;
    }
    return null;
  }

  @SuppressWarnings("unchecked")
  public static boolean sessionExpectsCompileRunWorkflow(OverAllState state) {
    if (Boolean.TRUE.equals(state.value("workflowCompileRun").orElse(false))) {
      return true;
    }
    Map<String, Object> intake =
        (Map<String, Object>) state.value("intakeIntent").orElse(null);
    if (intake == null) {
      return false;
    }
    return Boolean.TRUE.equals(intake.get("allowShellExec"))
        && Boolean.TRUE.equals(intake.get("needsPlanning"));
  }

  /** Human-readable label for prompts (title only — not used for classification). */
  @SuppressWarnings("unchecked")
  public static String currentStepLabel(OverAllState state) {
    Map<String, Object> step = currentUserStep(state);
    if (step != null) {
      String title = String.valueOf(step.getOrDefault("title", ""));
      String desc = String.valueOf(step.getOrDefault("description", ""));
      return (title + " " + desc).trim();
    }
    Map<String, Object> phase = currentPhase(state);
    if (phase != null) {
      String title = String.valueOf(phase.getOrDefault("title", ""));
      return title.trim();
    }
    return "";
  }

  @SuppressWarnings("unchecked")
  static boolean hasSuccessfulCompile(Map<String, Object> gathered) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      if (!"shell.exec".equals(String.valueOf(entry.get("kind")))) {
        continue;
      }
      String cmd = shellCommand(entry);
      if (cmd.isBlank()) {
        continue;
      }
      // Model-declared purpose takes priority; regex is fallback only when purpose is absent
      String purpose = entryPurpose(entry);
      if (purpose != null) {
        if (isCompilePurpose(entry)) {
          return true;
        }
        // purpose exists but is not compile/configure → this entry is NOT a compile, skip it
        continue;
      }
      if (COMPILE_CMD.matcher(cmd).find()) {
        return true;
      }
    }
    return false;
  }

  @SuppressWarnings("unchecked")
  public static boolean hasSuccessfulRun(Map<String, Object> gathered) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      if (!"shell.exec".equals(String.valueOf(entry.get("kind")))) {
        continue;
      }
      String cmd = shellCommand(entry);
      if (cmd.isBlank()) {
        continue;
      }
      // Model-declared purpose takes priority; regex is fallback only when purpose is absent
      String purpose = entryPurpose(entry);
      if (purpose != null) {
        if (isRunPurpose(entry)) {
          return true;
        }
        // purpose exists but is not run → this entry is NOT a program execution, skip it
        continue;
      }
      if (looksLikeProgramExecution(cmd)) {
        return true;
      }
    }
    return false;
  }

  @SuppressWarnings("unchecked")
  private static boolean hasSuccessfulPrepare(Map<String, Object> gathered) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      if ("fs.list".equals(String.valueOf(entry.get("kind"))) && !listResultEmpty(entry)) {
        return true;
      }
      if ("shell.exec".equals(String.valueOf(entry.get("kind")))) {
        String cmd = shellCommand(entry);
        if (cmd.contains("cmake") && !cmd.contains("--build")) {
          return true;
        }
      }
    }
    return false;
  }

  /** True for executing a built binary, not cmake/make/compile-only or directory listing. */
  public static boolean looksLikeProgramExecution(String cmd) {
    return looksLikeProgramExecution(cmd, null);
  }

  /** True for executing a built binary, not cmake/make/compile-only or directory listing. */
  public static boolean looksLikeProgramExecution(String cmd, String purpose) {
    if (cmd == null || cmd.isBlank()) {
      return false;
    }
    // Model-declared purpose takes priority over command-shape heuristics
    if (purpose != null && !purpose.isBlank()) {
      return "run".equalsIgnoreCase(purpose);
    }
    String t = cmd.trim();
    if (COMPILE_CMD.matcher(t).find()) {
      return false;
    }
    if (t.matches("(?i).*(\\bls\\b|\\bfind\\b|\\bcat\\b|\\bhead\\b).*")) {
      return false;
    }
    return RUN_CMD.matcher(t).find() || t.startsWith("./");
  }

  @SuppressWarnings("unchecked")
  public static boolean analyzeGoalMet(OverAllState state, Map<String, Object> gathered) {
    if (!Boolean.TRUE.equals(state.value("phaseHasAnalysisOutput").orElse(false))) {
      return false;
    }
    return hasSuccessfulSourceRead(gathered)
        || sessionHasSourceReads(state)
        || inputHasEmbeddedSource(state);
  }

  /**
   * True when the user message already carries source text (IDE selection, pasted snippet, or
   * action context) so an ANALYZE step does not require a redundant fs.read.
   */
  public static boolean inputHasEmbeddedSource(OverAllState state) {
    String input = String.valueOf(state.value("input").orElse(""));
    if (input.isBlank()) {
      return false;
    }
    if (input.contains("```") && input.length() >= 120) {
      return true;
    }
    if (input.contains("Context:") && SOURCE_FILE_IN_INPUT.matcher(input).find()) {
      return true;
    }
    return input.length() >= 400 && SOURCE_FILE_IN_INPUT.matcher(input).find();
  }

  /** Report/format step: prior phase already read sources; deliverable is structured text. */
  public static boolean synthesizeGoalMet(OverAllState state) {
    if (!sessionHasSourceReads(state)) {
      return false;
    }
    if (Boolean.TRUE.equals(state.value("phaseHasAnalysisOutput").orElse(false))) {
      return true;
    }
    if (SessionExecutionFacts.hasWrittenOutputs(state)) {
      return true;
    }
    String path = currentPhaseDeliverablePath(state);
    return !path.isBlank() && SessionExecutionFacts.isFileWritten(state, path);
  }

  /**
   * Inspect step: any tool failure in this phase blocks commit (partial reads are not enough).
   */
  public static boolean inspectGoalMet(OverAllState state, Map<String, Object> gathered) {
    if (inferStepKind(state) == StepKind.INSPECT
        && PhaseOutcomeHelper.gatheredHasFailures(gathered)) {
      return false;
    }
    if (inferStepKind(state) == StepKind.INSPECT) {
      return hasSuccessfulSourceRead(gathered) || sessionHasSourceReads(state);
    }
    return SessionExecutionFacts.inspectGoalMet(state, gathered);
  }

  @SuppressWarnings("unchecked")
  static String currentPhaseDeliverablePath(OverAllState state) {
    String phaseId = String.valueOf(state.value("phaseCursor").orElse(""));
    if (phaseId.isBlank()) {
      return "";
    }
    List<Map<String, Object>> phases =
        (List<Map<String, Object>>) state.value("phases").orElse(List.of());
    for (Map<String, Object> phase : phases) {
      if (phaseId.equals(String.valueOf(phase.get("id")))) {
        Object path = phase.get("deliverablePath");
        return path != null ? path.toString().trim() : "";
      }
    }
    return "";
  }

  public static boolean sessionHasSourceReads(OverAllState state) {
    return Boolean.TRUE.equals(state.value("sessionHasSourceReads").orElse(false));
  }

  public static boolean discoverGoalMet(OverAllState state, Map<String, Object> gathered) {
    if (!gatheredHasSuccessfulList(gathered)) {
      return false;
    }
    if (inferStepKind(state) != StepKind.DISCOVER) {
      return true;
    }
    // Discover is satisfied by a non-empty listing; path correction uses [SESSION EXECUTION FACTS].
    return true;
  }

  /** Whether a plan step/phase intent is a file deliverable (report/format) step. */
  public static boolean isDeliverableWriteIntent(String intentSlug) {
    String slug = normalizeIntentSlug(intentSlug);
    return INTENT_SYNTHESIZE.equals(slug)
        || "report".equals(slug)
        || "deliver".equals(slug)
        || "document".equals(slug)
        || "format".equals(slug)
        || "summarize".equals(slug);
  }

  /** Keep successful source reads in context across phase commits (bounded).
   *  @param gathered     the gathered info map from the current phase
   *  @param charsBudget  maximum total characters to retain; entries exceeding
   *                      this budget have their content truncated. Pass 0 or
   *                      negative to use the default budget (24000 chars).
   */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> retainSourceReadEntries(Map<String, Object> gathered, int charsBudget) {
    int effectiveBudget = charsBudget > 0 ? charsBudget : 24000;
    Map<String, Object> kept = new LinkedHashMap<>();
    int totalChars = 0;
    for (Map.Entry<String, Object> e : gathered.entrySet()) {
      if (!(e.getValue() instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      String kind = String.valueOf(entry.get("kind"));
      boolean shouldKeep = false;
      if ("fs.grep".equals(kind) || "code.outline".equals(kind)) {
        shouldKeep = true;
      } else if ("fs.read".equals(kind)) {
        String path = pathFromGatherEntry(entry);
        if (SOURCE_FILE.matcher(path).find()) {
          shouldKeep = true;
        }
      }
      if (!shouldKeep) continue;

      // Truncate content if this entry would push us over budget
      Map<String, Object> keptEntry = entry;
      Object resultObj = entry.get("result");
      if (resultObj instanceof Map<?, ?> resultMap) {
        Object contentObj = ((Map<String, Object>) resultMap).get("content");
        if (contentObj != null) {
          String contentStr = contentObj.toString();
          if (totalChars + contentStr.length() > effectiveBudget) {
            // Truncate: keep first 500 chars as a summary sketch
            int remaining = Math.max(500, effectiveBudget - totalChars);
            String truncated = contentStr.length() > remaining
                    ? contentStr.substring(0, remaining) + "\n... (truncated for context budget)"
                    : contentStr;
            Map<String, Object> newResult = new LinkedHashMap<>((Map<String, Object>) resultMap);
            newResult.put("content", truncated);
            Map<String, Object> newEntry = new LinkedHashMap<>(entry);
            newEntry.put("result", newResult);
            keptEntry = newEntry;
            totalChars += truncated.length();
          } else {
            totalChars += contentStr.length();
          }
        }
      }
      kept.put(e.getKey(), keptEntry);
      if (kept.size() >= 12) {
        break;
      }
    }
    return Map.copyOf(kept);
  }

  /** Keep successful source reads with default chars budget (24K). */
  public static Map<String, Object> retainSourceReadEntries(Map<String, Object> gathered) {
    return retainSourceReadEntries(gathered, 0);
  }

  @SuppressWarnings("unchecked")
  public static boolean hasSuccessfulSourceRead(Map<String, Object> gathered) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      String kind = String.valueOf(entry.get("kind"));
      if ("fs.grep".equals(kind) || "code.outline".equals(kind)) {
        return true;
      }
      if ("fs.read".equals(kind)) {
        String path = pathFromGatherEntry(entry);
        if (SOURCE_FILE.matcher(path).find()) {
          return true;
        }
      }
    }
    return false;
  }

  @SuppressWarnings("unchecked")
  static boolean gatheredHasSuccessfulList(Map<String, Object> gathered) {
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (GatheredInfoFormatter.entrySucceeded(entry)
          && "fs.list".equals(String.valueOf(entry.get("kind")))
          && !listResultEmpty(entry)) {
        return true;
      }
    }
    return false;
  }

  @SuppressWarnings("unchecked")
  private static boolean listResultEmpty(Map<String, Object> entry) {
    Object result = entry.get("result");
    if (!(result instanceof Map<?, ?> m)) {
      return true;
    }
    Object entries = ((Map<String, Object>) m).get("entries");
    return !(entries instanceof List<?> list) || list.isEmpty();
  }

  @SuppressWarnings("unchecked")
  private static String pathFromGatherEntry(Map<String, Object> entry) {
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

  /**
   * True when the gathered entry carries an LLM-declared {@code purpose} of {@code "compile"}.
   * Falls back to {@code "configure"} only for PREPARE steps (cmake configure without --build).
   */
  private static boolean isCompilePurpose(Map<String, Object> entry) {
    Object p = entry.get("purpose");
    if (p == null || p.toString().isBlank()) {
      return false;
    }
    String purpose = p.toString().toLowerCase(Locale.ROOT);
    return "compile".equals(purpose) || "configure".equals(purpose);
  }

  /** True when the gathered entry carries an LLM-declared {@code purpose} of {@code "run"}. */
  private static boolean isRunPurpose(Map<String, Object> entry) {
    Object p = entry.get("purpose");
    if (p == null || p.toString().isBlank()) {
      return false;
    }
    return "run".equalsIgnoreCase(p.toString());
  }

  /**
   * Extracts the LLM-declared purpose from a gathered entry, or null if absent.
   * Used by callers that need the raw purpose string (e.g. ShellCommandGate).
   */
  public static String entryPurpose(Map<String, Object> entry) {
    Object p = entry.get("purpose");
    return p != null && !p.toString().isBlank() ? p.toString() : null;
  }

  public static String stepAlreadySatisfiedDirective(OverAllState state) {
    if (!currentStepGoalSatisfied(state)) {
      return "";
    }
    StepKind kind = inferStepKind(state);
    return "\n\n[STEP GOAL ALREADY MET]\n"
        + "Tool results in [GATHERED CONTEXT] already satisfy this step ("
        + kind
        + ").\n"
        + "Do NOT rerun compile/run/read probes. Use textOutput with a brief summary and move on.\n"
        + "Earlier [FAILED] entries used a different approach — ignore them if the goal is met.\n"
        + "Plan steps are guidance; the user's goal matters more than the exact command (cmake vs g++).\n"
        + GraphExecutionJournal.combinedContextDirective(state);
  }
}
