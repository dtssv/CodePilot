/**
 * Prompt profiles — ordered lists of fixed block ids for the **parent**
 * assembler. Sub-agents use dedicated templates in `subagentPrompt.ts`
 * (buildSystemPrompt delegates when `ctx.subagent`); the SUBAGENT_* lists
 * below are retained for docs/tests of historical block sets only.
 */

import type { BlockId } from "./blocks.js";
import type { SubagentPromptProfile, SystemPromptContext } from "./types.js";

export type PromptProfile = "parent" | SubagentPromptProfile;

/** Parent agent — full static policy (tool-gated blocks still require tools). */
export const PARENT_BLOCKS: readonly BlockId[] = [
  "identity.parent",
  "precedence",
  "system.parent",
  "doing-tasks",
  "evidence",
  "code-conventions",
  "planning",
  "goals",
  "testing",
  "safety",
  "git",
  "using-tools",
  "tool-use",
  "mcp",
  "tone",
  "memory",
  "project-notes",
] as const;

/** Explore sub-agent — read/search specialist (no SE framing / tone / git). */
export const SUBAGENT_EXPLORE_BLOCKS: readonly BlockId[] = [
  "identity.sub",
  "role",
  "system.sub",
  "evidence",
  "safety",
  "using-tools",
  "tool-use",
] as const;

/** Plan sub-agent — explore + plan conclusion contract. */
export const SUBAGENT_PLAN_BLOCKS: readonly BlockId[] = [
  "identity.sub",
  "role",
  "system.sub",
  "evidence",
  "safety",
  "using-tools",
  "tool-use",
] as const;

/** Worker sub-agent — can mutate; keeps conventions + testing. */
export const SUBAGENT_WORKER_BLOCKS: readonly BlockId[] = [
  "identity.sub",
  "role",
  "system.sub",
  "evidence",
  "code-conventions",
  "testing",
  "executing-with-care",
  "safety",
  "using-tools",
  "tool-use",
] as const;

export const PROFILE_BLOCKS: Record<PromptProfile, readonly BlockId[]> = {
  parent: PARENT_BLOCKS,
  explore: SUBAGENT_EXPLORE_BLOCKS,
  plan: SUBAGENT_PLAN_BLOCKS,
  worker: SUBAGENT_WORKER_BLOCKS,
};

export function resolvePromptProfile(ctx: SystemPromptContext): PromptProfile {
  if (!ctx.subagent) return "parent";
  return ctx.subagentProfile ?? "explore";
}

export function blocksForContext(ctx: SystemPromptContext): readonly BlockId[] {
  return PROFILE_BLOCKS[resolvePromptProfile(ctx)];
}
