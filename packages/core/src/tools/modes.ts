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
  // start_goal only emits a request event; the host drives the loop (which
  // itself runs in whatever mode applies). No file side-effects here.
  "start_goal",
  // goal_status just reports the goal's terminal state (read by the goal loop
  // when one is driving); no file side-effects, useful in any mode.
  "goal_status",
]);

/** Tool names allowed in `plan` mode but NOT in `chat` mode. */
const PLAN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "plan_update",
 // plan_done is the plan-mode exit ramp.
  "plan_done",
 // memory_write is `write`-tier but harmless; allowed in plan to capture
 // findings while exploring. Excluded from chat on purpose.
  "memory_write",
]);

/** Tools that are NEVER allowed in restricted modes. */
const ALWAYS_DENIED: ReadonlySet<string> = new Set([
  "bash",
  "bash_kill",
  "write_file",
  "edit_file",
  "task",
 // Control tools for background sub-agents: dispatching needs `task` (denied
 // here), so their companions are denied in restricted modes too.
  "subagent_list",
  "subagent_wait",
  "subagent_interrupt",
 // Executes arbitrary model-written JS that can write files / run bash — same
 // (actually broader) risk profile as bash, so blocked in chat/plan.
  "code_mode",
 // Spawns an external agent subprocess — same risk profile as `task`.
  "harness_bridge",
]);

/** Tools that are blocked specifically in `chat` mode (state-modifying read-tier tools). */
const CHAT_DENIED: ReadonlySet<string> = new Set([
 // Records a plan event — chat mode wants the model to answer, not plan.
  "plan_update",
 // Side effect on memory files.
  "memory_write",
]);

/**
 * Pure function: given a list of tools (or registry) and an {@link AgentMode},
 * return the subset of tools that should be exposed to the model.
 *
 * For `agent` mode, returns the input list unchanged.
 *
 * For `chat` mode, only the read-only baseline is kept. Write/execute/network
 * tools are dropped, along with `plan_update` and `memory_write` (which are
 * state-modifying even though `plan_update` is `read`-tier).
 *
 * For `plan` mode, the read-only set plus `plan_update` (and `memory_write`)
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

/** Anchored glob: `*` → any run, `?` → one char; everything else literal and
 * case-insensitive (model ids vary in case across gateways). The pattern is
 * tested against both the full id and the bare name after the last `/`, so a
 * rule written as `glm*` matches `jdcloud/glm-5.2` without the user having to
 * know the provider prefix. */
function modelGlobMatch(pattern: string, modelId: string): boolean {
  const re =
    "^" +
    pattern
      .split(/(\*|\?)/)
      .map((part) =>
        part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("") +
    "$";
  let rx: RegExp;
  try {
    rx = new RegExp(re, "i");
  } catch {
    return false;
  }
  if (rx.test(modelId)) return true;
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 && rx.test(modelId.slice(slash + 1));
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