// Layered system prompt — public facade.
// Implementation lives in `./systemPrompt/` (blocks + profiles + build).
// Sub-agents use dedicated specialist templates in `./systemPrompt/subagentPrompt.ts`.

export type {
  OutputStyle,
  SubagentPromptProfile,
  SystemPromptContext,
  SystemPromptResult,
} from "./types.js";

export { assembleSections, type StaticSection } from "./assemble.js";
export {
  SUBAGENT_ROLE_BLOCK,
  SUBAGENT_PLAN_ROLE_BLOCK,
  renderSubagentRole,
  subagentStaticBody,
  buildSubagentSystemPrompt,
} from "./subagentPrompt.js";
export {
  PARENT_BLOCKS,
  SUBAGENT_EXPLORE_BLOCKS,
  SUBAGENT_PLAN_BLOCKS,
  SUBAGENT_WORKER_BLOCKS,
  PROFILE_BLOCKS,
  resolvePromptProfile,
  blocksForContext,
  type PromptProfile,
} from "./profiles.js";
export {
  buildSystemPrompt,
  refreshVolatileSystemPrompt,
  renderPlanBlock,
} from "./build.js";

export type { EnvironmentProvider, EnvironmentSnapshot, GitStatus } from "../config/env.js";
