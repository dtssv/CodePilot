export {
  SUBAGENT_ROLE_BLOCK,
  SUBAGENT_PLAN_ROLE_BLOCK,
  subagentStaticBody,
} from "../systemPrompt/index.js";
export {
  createSubagentRunner,
  resolveSubagentPermissions,
  resolveWorktreeRoots,
  type SubagentFactoryOptions,
} from "./runner.js";
export { assessSubagentOutcome } from "./outcome.js";
// Output degeneration detectors live in a standalone module (no agent/session
// deps) so the live streaming loop can use them too without a circular import.
// Re-exported here to preserve the existing public import surface.
export { detectDegenerateText, detectRunawayRepetition } from "../compaction/textDegeneration.js";