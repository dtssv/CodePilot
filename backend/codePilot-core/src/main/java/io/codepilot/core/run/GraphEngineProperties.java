package io.codepilot.core.run;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Tuning for {@link io.codepilot.core.graph.GraphEngineService} thread pool and memory budget. */
@ConfigurationProperties(prefix = "codepilot.graph")
public class GraphEngineProperties {

  /**
   * Max threads for graph-engine bounded elastic scheduler. 0 uses Reactor default
   * ({@code 10 * CPUs}).
   */
  private int schedulerThreadCap = 0;

  /** Queue size for graph-engine scheduler. 0 uses Reactor default (100_000). */
  private int schedulerQueueSize = 0;

  /**
   * Token budget for memory context orchestration.
   * Controls how many tokens of memories are loaded into the LLM prompt.
   * For models with 1M context, set to 200000+; default 6000 for backward compatibility.
   */
  private int memoryBudget = 6000;

  /**
   * Maximum number of project memories to load per run.
   * Increase for large-scale tasks (100+ tables); default 20 for backward compatibility.
   */
  private int maxProjectMemories = 20;

  /**
   * Maximum tokens for a single memory's detail when mounted.
   * Controls granularity of individual memory entries.
   */
  private int maxDetailTokens = 800;

  /**
   * Maximum number of generate passes per phase before forcing commit.
   * Default 10; increase for complex phases that need multiple LLM calls.
   */
  private int maxGeneratePassesPerPhase = 5;

  /**
   * Maximum number of phase failure repair attempts before abandoning.
   * Default 4; increase for complex tasks where more retries are acceptable.
   */
  private int maxPhaseFailureAttempts = 4;

  /**
   * Maximum repair-node invocations per phase (verify/repair loop).
   * Default 2; separate from {@link #maxPhaseFailureAttempts}.
   */
  private int maxRepairAttemptsPerPhase = 2;

  /**
   * Threshold of completed phases beyond which state archiving is triggered.
   * When completedPhases.size() exceeds this value, older phase details are
   * archived to Redis and only summaries remain in active graph state.
   * Default 50; set higher for very large tasks.
   */
  private int stateArchiveThreshold = 50;

  /**
   * Maximum total characters to retain in gatheredInfo across phase commits.
   * When the retained source-read entries exceed this budget, older entries
   * are truncated to keep essential context within budget.
   * Default 24000; for super-complex tasks with large codebases, increase to 48000+.
   */
  private int gatheredInfoCharsBudget = 24000;

  /**
   * Input length (chars) above which {@code ContextSplitAction} invokes the LLM split planner.
   * Default 32000 (~8k tokens).
   */
  private int contextSplitCharThreshold = 32000;

  /** Max input chars per LLM call when splitting very large documents. */
  private int contextSplitMaxCharsPerLlmCall = 400000;

  /** Fallback fixed-size chunk when LLM split fails. */
  private int contextSplitFallbackChunkSize = 8000;

  /** Max chars for shard summary section injected into the planning prompt. */
  private int planningShardSummaryMaxChars = 32000;

  /**
   * Optional model group/custom model ID for auxiliary tasks (memory classify, context split,
   * search evaluate). Blank = use the session's primary model.
   */
  private String auxiliaryModelId = "";

  /** {@link io.codepilot.core.model.ModelSource} name for {@link #auxiliaryModelId}, or blank. */
  private String auxiliaryModelSource = "";

  /** TTL for server-side gather result cache entries (minutes). */
  private int gatherCacheTtlMinutes = 30;

  /** Max entries in the gather result cache per JVM. */
  private int gatherCacheMaxEntries = 512;

  public int getSchedulerThreadCap() {
    return schedulerThreadCap;
  }

  public void setSchedulerThreadCap(int schedulerThreadCap) {
    this.schedulerThreadCap = schedulerThreadCap;
  }

  public int getSchedulerQueueSize() {
    return schedulerQueueSize;
  }

  public void setSchedulerQueueSize(int schedulerQueueSize) {
    this.schedulerQueueSize = schedulerQueueSize;
  }

  public int getMemoryBudget() {
    return memoryBudget;
  }

  public void setMemoryBudget(int memoryBudget) {
    this.memoryBudget = memoryBudget;
  }

  public int getMaxProjectMemories() {
    return maxProjectMemories;
  }

  public void setMaxProjectMemories(int maxProjectMemories) {
    this.maxProjectMemories = maxProjectMemories;
  }

  public int getMaxDetailTokens() {
    return maxDetailTokens;
  }

  public void setMaxDetailTokens(int maxDetailTokens) {
    this.maxDetailTokens = maxDetailTokens;
  }

  public int getMaxGeneratePassesPerPhase() {
    return maxGeneratePassesPerPhase;
  }

  public void setMaxGeneratePassesPerPhase(int maxGeneratePassesPerPhase) {
    this.maxGeneratePassesPerPhase = maxGeneratePassesPerPhase;
  }

  public int getMaxPhaseFailureAttempts() {
    return maxPhaseFailureAttempts;
  }

  public void setMaxPhaseFailureAttempts(int maxPhaseFailureAttempts) {
    this.maxPhaseFailureAttempts = maxPhaseFailureAttempts;
  }

  public int getMaxRepairAttemptsPerPhase() {
    return maxRepairAttemptsPerPhase;
  }

  public void setMaxRepairAttemptsPerPhase(int maxRepairAttemptsPerPhase) {
    this.maxRepairAttemptsPerPhase = maxRepairAttemptsPerPhase;
  }

  public int getStateArchiveThreshold() {
    return stateArchiveThreshold;
  }

  public void setStateArchiveThreshold(int stateArchiveThreshold) {
    this.stateArchiveThreshold = stateArchiveThreshold;
  }

  public int getGatheredInfoCharsBudget() {
    return gatheredInfoCharsBudget;
  }

  public void setGatheredInfoCharsBudget(int gatheredInfoCharsBudget) {
    this.gatheredInfoCharsBudget = gatheredInfoCharsBudget;
  }

  public int getContextSplitCharThreshold() {
    return contextSplitCharThreshold;
  }

  public void setContextSplitCharThreshold(int contextSplitCharThreshold) {
    this.contextSplitCharThreshold = contextSplitCharThreshold;
  }

  public int getContextSplitMaxCharsPerLlmCall() {
    return contextSplitMaxCharsPerLlmCall;
  }

  public void setContextSplitMaxCharsPerLlmCall(int contextSplitMaxCharsPerLlmCall) {
    this.contextSplitMaxCharsPerLlmCall = contextSplitMaxCharsPerLlmCall;
  }

  public int getContextSplitFallbackChunkSize() {
    return contextSplitFallbackChunkSize;
  }

  public void setContextSplitFallbackChunkSize(int contextSplitFallbackChunkSize) {
    this.contextSplitFallbackChunkSize = contextSplitFallbackChunkSize;
  }

  public int getPlanningShardSummaryMaxChars() {
    return planningShardSummaryMaxChars;
  }

  public void setPlanningShardSummaryMaxChars(int planningShardSummaryMaxChars) {
    this.planningShardSummaryMaxChars = planningShardSummaryMaxChars;
  }

  public String getAuxiliaryModelId() {
    return auxiliaryModelId;
  }

  public void setAuxiliaryModelId(String auxiliaryModelId) {
    this.auxiliaryModelId = auxiliaryModelId;
  }

  public String getAuxiliaryModelSource() {
    return auxiliaryModelSource;
  }

  public void setAuxiliaryModelSource(String auxiliaryModelSource) {
    this.auxiliaryModelSource = auxiliaryModelSource;
  }

  public int getGatherCacheTtlMinutes() {
    return gatherCacheTtlMinutes;
  }

  public void setGatherCacheTtlMinutes(int gatherCacheTtlMinutes) {
    this.gatherCacheTtlMinutes = gatherCacheTtlMinutes;
  }

  public int getGatherCacheMaxEntries() {
    return gatherCacheMaxEntries;
  }

  public void setGatherCacheMaxEntries(int gatherCacheMaxEntries) {
    this.gatherCacheMaxEntries = gatherCacheMaxEntries;
  }
}
