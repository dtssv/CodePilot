// Collaboration mode → tool-set filtering.
//
// The registry still owns all built-in tools; the agent loop asks for the
// "mode-filtered" subset at provider-request time. Filtering is a pure
// function so it is trivially unit-testable and avoids mutating the
// shared `ToolRegistry` (which would otherwise leak state across mode
// switches).
//
// `memory_write` is deliberately NOT considered safe in `chat`: while
// technically only a write to memory files, it is still a side effect and
// the chat-mode policy says "do not modify files; just give suggestions".
// Plan mode allows it because updating memory while planning is fine.

import type { AgentMode } from "../types.js";
import type { ToolDef, ToolRegistry } from "./types.js";
import { modelGlobMatch } from "../config/modelGlob.js";

/** Re-export — implementation lives in browser-safe `config/modelGlob`. */
export { modelGlobMatch };

/**
 * Tool names that are always safe (no side effects on user files). Used as
 * the read-only baseline for `chat` mode.
 */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "glob",
  "grep",
  "ls",
  "read_artifact",
  "web_fetch",
  "web_search",
  "bash_output",
  "ask_user_question",
  // Mode suggestion + task boundary have no file side-effects and are useful
  // in every mode (e.g. suggest `agent` from `plan`, or draw a task boundary).
  "suggest_mode",
  "start_new_task",
]);

/** Tool names allowed in `plan` mode but NOT in `chat` mode. */
const PLAN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "plan",
  // memory_write is write-tier but harmless in plan; excluded from chat.
  "memory_write",
]);

/** Tools that are NEVER allowed in restricted modes (agent mode still gets them). */
const ALWAYS_DENIED: ReadonlySet<string> = new Set([
  "bash",
  "bash_kill",
  "write_file",
  "edit_file",
  "task",
  "code_mode",
  "harness_bridge",
  // Goal loop: agent-only.
  "goal",
]);

/** Tools that are blocked specifically in `chat` mode (state-modifying read-tier tools). */
const CHAT_DENIED: ReadonlySet<string> = new Set([
  "plan",
  "memory_write",
]);

/**
 * Pure function: given a list of tools (or registry) and an {@link AgentMode},
 * return the subset of tools that should be exposed to the model.
 *
 * For `agent` mode, returns the input list unchanged.
 *
 * For `chat` mode, only the read-only baseline is kept. Write/execute/network
 * tools are dropped, along with `plan` and `memory_write` (which are
 * state-modifying even though `plan` is `read`-tier).
 *
 * For `plan` mode, the read-only set plus `plan` (and `memory_write`)
 * are kept. `bash`, `write_file`, `edit_file`, `task` remain forbidden.
 *
 * Tools not in any of the curated lists — for instance MCP tools — fall
 * through: in restricted modes they are dropped unless they are themselves
 * `read`-tier. In `agent` mode every tool passes through.
 */
export function filterToolsByMode(
  tools: readonly ToolDef[],
  mode: AgentMode
): ToolDef[] {
  if (mode === "agent") return tools.slice();

  return tools.filter((t) => {
    if (ALWAYS_DENIED.has(t.name)) return false;
    if (mode === "chat" && CHAT_DENIED.has(t.name)) return false;
 // Curated allow-list: built-ins known to be safe in this mode.
    const allowSet = mode === "plan"
      ? new Set([...READ_TOOLS, ...PLAN_ONLY_TOOLS])
      : READ_TOOLS;
    if (allowSet.has(t.name)) return true;
 // Unknown tool — MCP or a future builtin. Default behaviour:
 // drop in restricted modes, unless it is itself a read-tier tool.
    return t.permission === "read";
  });
}

/** Convenience overload for {@link ToolRegistry}. */
export function filterToolsByModeFromRegistry(
  registry: ToolRegistry,
  mode: AgentMode
): ToolDef[] {
  return filterToolsByMode(registry.all(), mode);
}

/** One per-model exposure-downgrade rule (see `CodepilotConfig.toolExposure`). */
export interface ToolExposureRule {
  models: string[];
  drop: string[];
}

/**
 * Apply per-model exposure downgrade on top of the mode-filtered list. For a
 * model whose id matches any rule's `models` glob, every tool named in that
 * rule's `drop` is removed. Pure and total: unknown tool names in `drop` are
 * simply absent; an empty/undefined ruleset returns the input unchanged. This
 * can only REMOVE tools, never add — it runs after mode filtering.
 */
export function filterToolsByModel(
  tools: readonly ToolDef[],
  modelId: string,
  rules: readonly ToolExposureRule[] | undefined,
): ToolDef[] {
  if (!rules || rules.length === 0) return tools.slice();
  const dropped = new Set<string>();
  for (const rule of rules) {
    if (rule.models.some((m) => modelGlobMatch(m, modelId))) {
      for (const name of rule.drop) dropped.add(name);
    }
  }
  if (dropped.size === 0) return tools.slice();
  return tools.filter((t) => !dropped.has(t.name));
}

/** Names of tools that would be retained for the given mode. */
export function filterToolNames(
  tools: readonly ToolDef[],
  mode: AgentMode
): string[] {
  return filterToolsByMode(tools, mode).map((t) => t.name);
}