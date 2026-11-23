// Layered system prompt builder (parent agent).
//
// Three tiers (cache-friendly):
//   1. staticPrefix  — identity + policy sections (byte-stable for a given tool-set)
//   2. stableContext — lean env / git identity / thin memory index / skills
//   3. volatileSuffix — now / mode / permission / delivery_roots / plan /
//                       session notes (sandbox, resume, …)
//
// Static sections come from fixed blocks + profiles (see blocks.ts / profiles.ts).
// Sub-agents use a dedicated specialist path — see subagentPrompt.ts.

import { assembleSections } from "./assemble.js";
import { materializeBlocks } from "./blocks.js";
import { buildHarnessSuffix, buildVolatileHarness, renderPlanBlock } from "./harness.js";
import { blocksForContext } from "./profiles.js";
import { buildSubagentSystemPrompt } from "./subagentPrompt.js";
import type { OutputStyle, SystemPromptContext, SystemPromptResult } from "./types.js";
import type { AgentMode } from "../types.js";

/** Doc-only budget target for the static harness prefix. */
const STATIC_PREFIX_TARGET_TOKENS = 3500;
void STATIC_PREFIX_TARGET_TOKENS;

export { renderPlanBlock };

export async function buildSystemPrompt(
  ctx: SystemPromptContext,
): Promise<SystemPromptResult> {
  // Specialist short templates — do not assemble the parent block profile.
  if (ctx.subagent) {
    return buildSubagentSystemPrompt(ctx);
  }

  const staticPrefix = buildStaticPrefix(ctx);
  const { stable, volatile } = await buildHarnessSuffix(ctx, {
    mode: "parent",
    modeGuidance: modeGuidance(ctx.mode ?? "agent", ctx.toolNames),
    outputStyleGuidance: outputStyleGuidance(ctx.outputStyle ?? "concise"),
  });
  return assembleResult(staticPrefix, stable, volatile);
}

/**
 * Refresh only the volatile tail, reusing a previously built cached prefix.
 * Callers use this when permission / sandbox / delivery / plan / output-style
 * change — anything that must NOT rewrite staticPrefix or stableContext (and
 * must not re-snapshot git/memory into the cached system block).
 */
export async function refreshVolatileSystemPrompt(
  previous: Pick<SystemPromptResult, "staticPrefix" | "stableContext">,
  ctx: SystemPromptContext,
): Promise<SystemPromptResult> {
  const volatile = await buildVolatileHarness(ctx, {
    mode: ctx.subagent ? "subagent" : "parent",
    modeGuidance: modeGuidance(ctx.mode ?? "agent", ctx.toolNames),
    outputStyleGuidance: outputStyleGuidance(ctx.outputStyle ?? "concise"),
  });
  return assembleResult(previous.staticPrefix, previous.stableContext, volatile);
}

function assembleResult(
  staticPrefix: string,
  stable: string,
  volatile: string,
): SystemPromptResult {
  const full =
    staticPrefix +
    (staticPrefix.endsWith("\n") ? "" : "\n") +
    "\n" +
    stable +
    (volatile ? `\n\n${volatile}` : "");
  return {
    staticPrefix,
    stableContext: stable,
    volatileSuffix: volatile,
    dynamicSuffix: stable,
    full,
  };
}

function buildStaticPrefix(ctx: SystemPromptContext): string {
  const have = new Set(ctx.toolNames);
  const parts = materializeBlocks(blocksForContext(ctx), ctx);
  return assembleSections(parts, have);
}

function modeGuidance(mode: AgentMode, _toolNames: string[]): string {
  switch (mode) {
    case "chat":
      return [
        "**Mode: \`chat\` (read-only Q&A).**",
        "- No mutating tools. Do not change the codebase or pretend to; describe the diff instead if asked to edit.",
        "- Short prose answers; clarify only if needed (≤4 questions).",
      ].join("\n");
    case "plan":
      return [
        "**Mode: \`plan\` (read-only exploration + planning).**",
        "- Read-only tools plus \`plan\` / \`memory_write\` (explicit remember only). No \`bash\` / writes / \`task\`.",
        "- Surface unknowns; when ready call \`plan\` with \`action: \"done\"\` and a one-paragraph summary.",
      ].join("\n");
    case "agent":
    default:
      return [
        "**Mode: \`agent\` (full autonomy).**",
        "- Keep calling tools while work remains; unfinished plan steps stay open across turns.",
        "- **Least surprise.** Smallest verifiable change; ask before destructive ops (see Safety). Permission default is \`ask\` unless \`auto-edit\` / \`yolo\` is active.",
      ].join("\n");
  }
}

function outputStyleGuidance(style: OutputStyle): string {
  switch (style) {
    case "explanatory":
      return [
        "### Output Style: \`explanatory\`",
        "- Lead with **why** then **what**; one-sentence trade-offs for non-obvious choices. No fluff.",
      ].join("\n");
    case "learning":
      return [
        "### Output Style: \`learning\`",
        "- Teach as you go (name the concept + one line); cite \`file:line\`. Do not over-explain what the user already knows.",
      ].join("\n");
    case "concise":
    default:
      return [
        "### Output Style: \`concise\` (default)",
        "- Conclusion then evidence; one word when one word suffices. Do not teach unless asked.",
      ].join("\n");
  }
}
