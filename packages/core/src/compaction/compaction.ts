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
} from "./geometry.js";

export type { CompactionResult, FoldOptions } from "./fold.js";
export { FOLD_DEFER_TOOLS, foldToolResults } from "./fold.js";

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
} from "./summarize.js";