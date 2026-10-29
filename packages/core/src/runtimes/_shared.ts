// Helpers shared by the example runtimes.
//
// Both example runtimes work the same way: they run the built-in loop one or
// more times with adjusted deps, then combine the results. Neither reaches
// into the loop's internals, which is the point — they are what a plugin
// runtime can do with nothing but the `RuntimeToolkit`.

import type { AgentDeps, AgentRunResult } from "../agent.js";
import type { Event } from "../types.js";

/** The system-prompt triple the agent loop consumes. */
export type SystemPromptParts = NonNullable<AgentDeps["systemPrompt"]>;

/**
 * Append runtime instructions to the system prompt's volatile per-turn tier.
 *
 * The suffix is injected as the per-turn `<runtime_context>` message (its own
 * `system`-role message, placed just before the current turn) rather than into
 * the cached static+stable system block — so the cacheable prefix stays
 * byte-identical and prompt-cache hit rates are unaffected. Falls back to
 * `dynamicSuffix` for prompts built before the stable/volatile split.
 */
export function withPromptSuffix(
  prompt: SystemPromptParts | undefined,
  extra: string,
): SystemPromptParts {
  if (!prompt) {
    return { staticPrefix: "", dynamicSuffix: "", volatileSuffix: extra, full: extra };
  }
  const base = prompt.volatileSuffix ?? prompt.dynamicSuffix;
  const volatileSuffix = [base, extra]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");
  return {
    ...prompt,
    volatileSuffix,
    full: [prompt.full, extra].filter((s) => s && s.trim().length > 0).join("\n\n"),
  };
}

/**
 * Concatenate successive runs into one result. Events keep their order, the
 * final text comes from the last run that produced any, and `hadToolCalls`
 * is true when any run called a tool.
 */
export function mergeRunResults(results: AgentRunResult[]): AgentRunResult {
  const events: Event[] = [];
  let hadToolCalls = false;
  let finalText = "";
  for (const r of results) {
    events.push(...r.events);
    hadToolCalls = hadToolCalls || r.hadToolCalls;
    if (r.finalText.trim().length > 0) finalText = r.finalText;
  }
  return { events, hadToolCalls, finalText };
}

/** True when the run was cancelled through the session's abort signal. */
export function aborted(deps: AgentDeps): boolean {
  return deps.signal?.aborted === true;
}
