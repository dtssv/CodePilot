// Convergence / stall ceilings, exploration evidence, and per-turn live context
// (plan block + progress ledger + system notices).

import type { Event } from "../types.js";
import { extractPlan } from "../compaction/compaction.js";
import { renderPlanBlock } from "../systemPrompt/index.js";
import { signature as toolSignature } from "./doomLoop.js";
import type { ToolExecResult } from "./agent-tools.js";

/** Sub-agent prompt profile — kept local to avoid importing AgentDeps from
 * agent.ts (which would cycle: agent → convergence → agent). */
type SubagentProfile = "explore" | "plan" | "worker";

/** Conclusion section headers for sub-agent wind-down / stall locks. Plan
 * specialists must not be told to emit Findings. */
export function subagentConclusionShape(profile?: SubagentProfile): string {
  if (profile === "plan") {
    return "### Plan / ### Critical files / ### Risks / ### Open questions, or ### Blocker";
  }
  return "### Findings / ### Key references / ### Recommendations, or ### Blocker";
}

/** Soft convergence ceiling: when neither maxTurns nor config.convergenceCap is
 * set, the loop winds down after this many turns and disables tool calls for
 * the final turn. Backstop against semantic looping the exact-signature
 * DoomLoopDetector can't catch. */
export const DEFAULT_CONVERGENCE_CAP = 60;
/** Turns of slack between where wind-down starts (tools disabled + synthesis
 * urge) and the absolute hard break. Gives the model room to actually write its
 * answer after tools are locked, while still guaranteeing termination if a
 * provider ignores `toolChoice:"none"`. */
export const CONVERGENCE_HARD_SLACK = 3;
/** Turns before the governing ceiling at which the "turns left" nudge fires
 * (and a `turn_budget` warning is surfaced to the host). */
export const DEFAULT_REMAINING_NUDGE_AT = 2;

/** Progress-gated stall ladder. Catches models calling read-only/variant tools
 * turn after turn without changing durable state (textually different, so the
 * doom loop / plan-stall don't fire). Escalate: soft nudge → stronger nudge →
 * wind-down path. A later turn with real progress resets the streak. */
export const NO_PROGRESS_SOFT_TURNS = 8;
export const NO_PROGRESS_STRONG_TURNS = 12;
export const NO_PROGRESS_LOCK_TURNS = 16;

/** Exploration-stall ladder — the read-only analogue of the no-progress ladder,
 * for investigations (debugging, code reading) that legitimately never write.
 * Deliberately wider than the write ladder because reading toward a root cause
 * takes more turns than editing, but still terminates: a turn that surfaces no
 * NEW evidence (only re-reads the same ground) extends the streak, and the lock
 * tier reuses the same wind-down backstop as the write ladder. */
export const NO_EXPLORATION_SOFT_TURNS = 12;
export const NO_EXPLORATION_STRONG_TURNS = 18;
export const NO_EXPLORATION_LOCK_TURNS = 24;

/** Consecutive all-error turns before the failure notice fires. Orthogonal to
 * the progress ladders: it catches a run whose attempts keep erroring (not a
 * slow-progress spin), and steers toward a different approach or an honest
 * blocker report. Mirrors the common "3 consecutive execution failures is a
 * blocker" heuristic; it nudges rather than locks, since a different operation
 * may still succeed. */
export const CONSECUTIVE_FAILURE_NOTICE_TURNS = 3;

/** Read-only tools whose repeated calls are evaluated for "new evidence". A
 * fresh read / first-seen grep hit / not-before-run command resets the
 * exploration streak; a cached-replay read or a re-hit of known paths does not.
 * `bash`/`lsp_navigate` are read-ish here only for the evidence signal — they
 * are NOT treated as durable progress. */
export const EXPLORATION_READ_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "ls",
  "bash",
  "lsp_navigate",
]);

/** Tools (by name) whose successful call counts as durable progress even though
 * their permission is "read": `task` delivers a sub-agent conclusion and
 * `memory_write` commits durable knowledge. Write-permission tools (write_file,
 * edit_file, apply_patch, notebook_edit, …) are detected by permission, not
 * name, so this list stays small. */
export const DURABLE_PROGRESS_TOOLS = new Set(["task", "memory_write"]);

/**
 * Whether a successful read-only tool result is NEW evidence (fresh ground) vs
 * a repeat of what the investigation already saw. Drives the exploration-stall
 * track so a genuine debug session (which never writes) is not wound down while
 * it keeps turning up new facts, yet a model re-reading the same files/windows
 * in circles still converges.
 *
 * - read_file / grep / glob / ls (dedupable): the tool layer serves a repeated
 *   identical call from the dedup cache and stamps a `[dedup:` prefix, so a
 *   result WITHOUT that prefix is a first-time read → new evidence. A varied
 *   call (new pattern / new window past the overlap threshold) also misses the
 *   cache and so counts, which is correct — it is a new probe.
 * - bash / lsp_navigate (not dedupable): judged by command signature — a repeat
 *   with identical args is not new evidence; a non-empty first run is. Mutating
 *   the set is the caller's job (so a repeat within the SAME turn still counts
 *   once), hence `seen` is passed in.
 * - Empty output is never new evidence.
 */
export function isNewReadEvidence(
  toolName: string,
  result: ToolExecResult,
  seenReadCommandSigs: Set<string>,
  input: unknown,
): boolean {
  if (result.isError) return false;
  if (!EXPLORATION_READ_TOOLS.has(toolName)) return false;
  const body = result.content ?? "";
  if (body.trim() === "") return false;
  // Dedupable reads: a cache replay prefix means we have seen this exact ground.
  if (toolName === "read_file" || toolName === "grep" || toolName === "glob" || toolName === "ls") {
    return !body.startsWith("[dedup:");
  }
  // bash / lsp_navigate: signature-based first-run check.
  const sig = toolSignature(toolName, input);
  if (seenReadCommandSigs.has(sig)) return false;
  seenReadCommandSigs.add(sig);
  return true;
}

/** Reminder surfaced (via runtime_context, not the transcript) when the plan
 * hasn't advanced for several tool-calling turns. */
const PLAN_STALL_NOTICE = `<plan_stall>
You've called tools for several turns without advancing your plan. You likely have enough information — stop exploring and move on: mark the current plan step complete, start the next one, or produce the synthesis/output the task asks for. If you're stuck, summarize what you've learned so far and say what's blocking you.
</plan_stall>`;

const LEDGER_MAX_LINES = 40;

/**
 * Per-turn context the model needs fresh every turn: the CURRENT plan and a
 * ledger of calls already made (old tool output gets folded away during long
 * runs). `systemNotices` are engine-generated, out-of-band, never spoofable.
 */
export function buildLiveContext(
  all: Event[],
  produced: Event[],
  opts: { planStalled?: boolean; systemNotices?: string[]; relevantMemories?: string } = {},
): string {
  const parts: string[] = [];
  const planBlock = renderPlanBlock(extractPlan(all));
  if (planBlock) parts.push(planBlock);
  const ledger = buildProgressLedger(produced);
  if (ledger) parts.push(ledger);
  if (opts.planStalled) parts.push(PLAN_STALL_NOTICE);
  if (opts.relevantMemories && opts.relevantMemories.trim().length > 0) {
    parts.push(opts.relevantMemories.trim());
  }
  for (const notice of opts.systemNotices ?? []) {
    parts.push(`<system_notice>\n${notice}\n</system_notice>`);
  }
  return parts.join("\n\n");
}

export function buildProgressLedger(events: Event[]): string {
  const results = new Map<string, { isError: boolean }>();
  for (const e of events) {
    if (e.type === "tool_result") results.set(e.toolCallId, { isError: e.isError === true });
  }
  const rows = new Map<string, { count: number; ok: number; failed: number }>();
  for (const e of events) {
    if (e.type !== "tool_call" || e.name === "plan_update") continue;
    const r = results.get(e.id);
    if (!r) continue;
    const key = describeCall(e.name, e.input);
    const row = rows.get(key) ?? { count: 0, ok: 0, failed: 0 };
    row.count++;
    if (r.isError) row.failed++;
    else row.ok++;
    rows.delete(key); // re-insert so the most recent calls sort last
    rows.set(key, row);
  }
  if (rows.size === 0) return "";
  const lines = [...rows.entries()].slice(-LEDGER_MAX_LINES).map(([key, row]) => {
    const status = row.failed === 0 ? "ok" : row.ok === 0 ? "failed" : `${row.ok} ok / ${row.failed} failed`;
    return `- ${key} — ${status}${row.count > 1 ? ` (×${row.count})` : ""}`;
  });
  const omitted = rows.size > LEDGER_MAX_LINES ? `\n(${rows.size - LEDGER_MAX_LINES} earlier calls omitted)` : "";
  return `<progress>
Tool calls you already made for the current request; their results are in the conversation above (possibly folded). Do not repeat one unless its inputs or the files it depends on changed since — build on the results instead.${omitted}
${lines.join("\n")}
</progress>`;
}

function describeCall(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const k of ["command", "path", "file_path", "pattern", "url", "query", "objective", "description", "ref"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") {
      const one = v.replace(/\s+/g, " ").trim();
      return `${name} ${one.length > 90 ? `${one.slice(0, 90)}…` : one}`;
    }
  }
  return name;
}
