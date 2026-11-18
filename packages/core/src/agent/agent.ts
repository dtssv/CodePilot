// Agent loop: stream from the ChatProvider, parse tool calls, run permission
// checks, execute tools, append results, and loop until no more tool calls.
// Layout: agent.ts (barrel); agent-types.ts; agent-run/ (main loop, agent-run.ts shim);
// agent-messages.ts (messages + tool defs + streamOnce); agent-tools.ts
// (runOneTool + token estimates); agent-barrier.ts (abort + parallel barrier);
// agent-convergence.ts (caps / stall / live context); agent-resume.ts
// (truncation / overflow resume); agent-plan.ts (plan / soft-stop heuristics).

export type { AgentDeps, AgentRunInput, AgentRunResult } from "./agent-types.js";
export { runAgent } from "./agent-run.js";
export { isTransientError } from "./transientError.js";

// Re-export public helpers so existing `from "./agent.js"` / test imports keep working.
export {
  isAbortError,
  isAbortMessage,
  isParallelSafeTool,
  runToolsWithBarrier,
} from "./agent-barrier.js";
export {
  buildLiveContext,
  buildProgressLedger,
} from "./agent-convergence.js";
export {
  looksLikePseudoToolCall,
  isContextOverflowError,
} from "./agent-resume.js";
export {
  hasUnfinishedPlan,
  isWaitingForUser,
  looksLikeIncompleteTurn,
} from "./agent-plan.js";