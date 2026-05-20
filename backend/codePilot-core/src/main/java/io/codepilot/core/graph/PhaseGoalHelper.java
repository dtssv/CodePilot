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

  /** Shell command shape: build tools (language-agnostic command tokens, not plan titles). */
  private static final Pattern COMPILE_CMD =
      Pattern.compile(
          "(?i)(g\\+\\+|clang\\+\\+|cmake\\s+--build|\\bmake\\b|mvn\\s|gradle\\s|npm\\s+run\\s+build|cargo\\s+build)");
  /** Shell command shape: executing a built artifact path. */
  private static final Pattern RUN_CMD =
      Pattern.compile(
          "(?i)(^|[;&|]\\s*)(\\./[^\\s'\"]+|build/[^\\s'\"]+/[^\\s'\"]+|build/[^\\s'\"]+$)");
  /** Source file extensions for analysis deliverables (path structure, not prose). */
  private static final Pattern SOURCE_FILE =
      Pattern.compile("(?i)\\.(cpp|cc|c|h|hpp|java|py|go|rs|ts|js|kt|rb|cs|swift)$");

  private PhaseGoalHelper() {}

  /** Step kinds aligned with planner {@code phases[].intent} slugs. */
  public enum StepKind {
    COMPILE,
    RUN,
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
  public static final String INTENT_ANALYZE = "analyze";
  public static final String INTENT_INSPECT = "inspect";
  public static final String INTENT_PREPARE = "prepare";
  public static final String INTENT_DISCOVER = "discover";
  public static final String INTENT_SYNTHESIZE = "synthesize";
  public static final String INTENT_CODE_CHANGE = "code-change";

  @SuppressWarnings("unchecked")
  public static boolean currentStepGoalSatisfied(OverAllState state) {
    Map<String, Object> gathered =
        (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
    if (gathered.isEmpty()) {
      return false;
    }
    StepKind kind = inferStepKind(state);
    return switch (kind) {
      case COMPILE -> hasSuccessfulCompile(gathered);
      case RUN -> hasSuccessfulRun(gathered);
      case ANALYZE -> analyzeGoalMet(state, gathered);
      case INSPECT -> SessionExecutionFacts.inspectGoalMet(state, gathered);
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
   * Resolve step kind from structured plan metadata first, then session workflow position, then
   * GENERIC. Never matches free-text step titles.
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
    StepKind fromWorkflow = stepKindFromCompileRunWorkflow(state);
    if (fromWorkflow != null) {
      return fromWorkflow;
    }
    return StepKind.GENERIC;
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
      case INTENT_ANALYZE, "analysis", "review", "explain" -> StepKind.ANALYZE;
      case INTENT_SYNTHESIZE, "report", "format", "summarize", "document", "deliver" ->
          StepKind.SYNTHESIZE;
      case INTENT_INSPECT, "read", "verify", "check" -> StepKind.INSPECT;
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
    if (cmd == null || cmd.isBlank()) {
      return false;
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
    if (!hasSuccessfulSourceRead(gathered) && !sessionHasSourceReads(state)) {
      return false;
    }
    return Boolean.TRUE.equals(state.value("phaseHasAnalysisOutput").orElse(false));
  }

  /** Report/format step: prior phase already read sources; deliverable is structured text. */
  public static boolean synthesizeGoalMet(OverAllState state) {
    if (!sessionHasSourceReads(state)) {
      return false;
    }
    return Boolean.TRUE.equals(state.value("phaseHasAnalysisOutput").orElse(false));
  }

  public static boolean sessionHasSourceReads(OverAllState state) {
    return Boolean.TRUE.equals(state.value("sessionHasSourceReads").orElse(false));
  }

  @SuppressWarnings("unchecked")
  public static boolean discoverGoalMet(OverAllState state, Map<String, Object> gathered) {
    if (!gatheredHasSuccessfulList(gathered)) {
      return false;
    }
    String input = String.valueOf(state.value("input").orElse("")).toLowerCase(Locale.ROOT);
    if (!input.contains("leetcode")) {
      return true;
    }
    return listResultMatchesKeyword(gathered, "leetcode");
  }

  /** Keep successful source reads in context across phase commits (bounded). */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> retainSourceReadEntries(Map<String, Object> gathered) {
    Map<String, Object> kept = new LinkedHashMap<>();
    for (Map.Entry<String, Object> e : gathered.entrySet()) {
      if (!(e.getValue() instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)) {
        continue;
      }
      String kind = String.valueOf(entry.get("kind"));
      if ("fs.grep".equals(kind) || "code.outline".equals(kind)) {
        kept.put(e.getKey(), entry);
      } else if ("fs.read".equals(kind)) {
        String path = pathFromGatherEntry(entry);
        if (SOURCE_FILE.matcher(path).find()) {
          kept.put(e.getKey(), entry);
        }
      }
      if (kept.size() >= 12) {
        break;
      }
    }
    return Map.copyOf(kept);
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
  static boolean listResultMatchesKeyword(Map<String, Object> gathered, String keyword) {
    String needle = keyword.toLowerCase(Locale.ROOT);
    for (Object value : gathered.values()) {
      if (!(value instanceof Map<?, ?> raw)) {
        continue;
      }
      Map<String, Object> entry = (Map<String, Object>) raw;
      if (!GatheredInfoFormatter.entrySucceeded(entry)
          || !"fs.list".equals(String.valueOf(entry.get("kind")))) {
        continue;
      }
      Object result = entry.get("result");
      if (!(result instanceof Map<?, ?> m)) {
        continue;
      }
      Object entries = ((Map<String, Object>) m).get("entries");
      if (!(entries instanceof List<?> list)) {
        continue;
      }
      for (Object item : list) {
        if (item instanceof Map<?, ?> row) {
          Object nameVal = row.get("name");
          if (nameVal == null) nameVal = row.get("path");
          String name = String.valueOf(nameVal);
          if (name.toLowerCase(Locale.ROOT).contains(needle)) {
            return true;
          }
        }
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
        + SessionExecutionFacts.adaptationDirective(state);
  }
}
