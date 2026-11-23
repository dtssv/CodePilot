// Layered compaction barrel — re-exports the split modules so existing
// `compaction.js` import paths keep working.

export type {
  CompactionOptions,
  CompactionDecision,
  CompactionGeometry,
} from "./geometry.js";
export {
  shouldCompact,
  DEFAULT_COMPACTION_FRACTION,
  SOFT_COMPACTION_RATIO,
  PROVIDER_INPUT_COMPACTION_RATIO,
  HARD_TRIM_RATIO,
  FORCED_SHRINK_RATIO,
  compactionGeometry,
  estimateEventTokens,
  usageSignalsCompact,
  midRunCompactPressure,
} from "./geometry.js";

export type { CompactionResult, FoldOptions } from "./fold.js";
export {
  FOLD_DEFER_TOOLS,
  DEFAULT_MAX_TOOL_RESULTS_IN_CONTEXT,
  foldToolResults,
  buildToolResultStub,
} from "./fold.js";

export type { ToolResultFold, PrunePlan, PlanToolResultPruneOptions } from "./prune.js";
export {
  DEFAULT_PRUNE_MIN_CHARS,
  DEFAULT_PRUNE_KEEP_MESSAGES,
  DEFAULT_PRUNE_TRIGGER_CHARS,
  planToolResultPrune,
  applyToolResultPruneOverlays,
  collectPruneOverlays,
  microFoldEventFromPlan,
} from "./prune.js";

export { SUMMARY_SYSTEM_PROMPT } from "./summarize.js";
export {
  renderTranscriptArchive,
  liveTranscript,
  rewoundIndices,
  visibleHistory,
  trimEventsToBudget,
  buildLocalHandoffSummary,
  compact,
  composeSummaryPrompt,
  mergeCompactInstructions,
  extractPlan,
  serializeForSummary,
  serializeEventsForSummary,
} from "./summarize.js";

export {
  TOOL_INPUT_SPILL_CHARS,
  TOOL_INPUT_FIELD_HEAD,
  TOOL_INPUT_FIELD_TAIL,
  measureToolInputChars,
  truncateToolCallInput,
  spillToolCallInputForContext,
} from "./toolInput.js";
export type { SpillToolCallInputResult } from "./toolInput.js";