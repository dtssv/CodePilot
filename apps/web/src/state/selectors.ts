// Derived views over the row list. Pure functions so the presentation rules
// (what collapses into a step group, which files count as deliverables) are
// unit-tested rather than buried in components.

import type { PlanStep } from "@codepilot/core";
import type { MessageRow, Row, ToolRow } from "./rows.js";
import { hasVisibleAssistantContent } from "./stripThinking.js";

export type ToolCategory =
  | "read"
  | "list"
  | "search"
  | "edit"
  | "write"
  | "bash"
  | "web"
  | "task"
  | "memory"
  | "plan"
  | "ask"
  | "other";

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  read_file: "read",
  read: "read",
  read_artifact: "read",
  view: "read",
  list_dir: "list",
  ls: "list",
  glob: "search",
  grep: "search",
  search: "search",
  code_search: "search",
  semantic_search: "search",
  edit_file: "edit",
  edit: "edit",
  multi_edit: "edit",
  apply_patch: "edit",
  str_replace: "edit",
  write_file: "write",
  write: "write",
  create_file: "write",
  bash: "bash",
  bash_output: "bash",
  bash_kill: "bash",
  write_stdin: "bash",
  read_image: "read",
  notebook_edit: "edit",
  skill: "task",
  shell: "bash",
  run_command: "bash",
  web_fetch: "web",
  fetch: "web",
  web_search: "web",
  task: "task",
  spawn_agent: "task",
  team: "task",
  memory_write: "memory",
  remember: "memory",
  memory: "memory",
  plan_update: "plan",
  todo_write: "plan",
  update_plan: "plan",
  ask_user_question: "ask",
  plan_done: "ask",
};

export function toolCategory(name: string): ToolCategory {
  const direct = CATEGORY_BY_NAME[name];
  if (direct) return direct;
  const n = name.toLowerCase();
  if (n.includes("read")) return "read";
  if (n.includes("search") || n.includes("grep") || n.includes("find")) return "search";
  if (n.includes("edit") || n.includes("patch") || n.includes("replace")) return "edit";
  if (n.includes("write") || n.includes("create")) return "write";
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "bash";
  if (n.includes("web") || n.includes("fetch") || n.includes("http")) return "web";
  if (n.includes("memory")) return "memory";
  if (n.includes("agent") || n.includes("task")) return "task";
  return "other";
}

/** Short English verb for a step header; the UI translates it. */
export const CATEGORY_VERB: Record<ToolCategory, string> = {
  read: "Read",
  list: "Listed",
  search: "Searched",
  edit: "Edited",
  write: "Wrote",
  bash: "Ran command",
  web: "Fetched",
  task: "Delegated",
  memory: "Saved memory",
  plan: "Updated plan",
  ask: "Asked you",
  other: "Called",
};

/** The one-line target of a tool call: path, command, pattern, url… */
export function toolTarget(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return oneLine(String(input), 160);
  const o = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "objective", "description", "ref"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") return oneLine(v, 160);
  }
  return "";
}

/** One piece inside an assistant turn (tools, text, plan, …). */
export type TurnPart =
  | { kind: "message"; msg: MessageRow }
  | { kind: "steps"; tools: ToolRow[] }
  | { kind: "plan"; steps: PlanStep[]; latest: boolean }
  | { kind: "row"; row: Exclude<Row, { kind: "message" | "tool" | "plan" | "usage" }> };

export type Block =
  | { kind: "message"; key: string; msg: MessageRow }
 /** Everything after a user message until the next one — one avatar, one Q&A. */
  | { kind: "assistant_turn"; key: string; parts: TurnPart[] };

/**
 * Turn rows into render blocks:
 * - one user bubble per user message,
 * - everything until the next user message folds into a single
 * `assistant_turn` (one left avatar) so multi-step tool loops still
 * read as 一问一答,
 * - consecutive tool rows collapse into one "steps" group inside the turn,
 * - usage rows are dropped (totals live in the status bar),
 * - only the most recent plan renders in full; earlier ones become a
 * compact "plan updated" marker,
 * - assistant shells with no visible content are skipped.
 */
export function groupRows(rows: Row[]): Block[] {
  const blocks: Block[] = [];
  let lastPlanIdx = -1;
  rows.forEach((r, i) => {
    if (r.kind === "plan") lastPlanIdx = i;
  });

  let turnParts: TurnPart[] = [];
  let turnKey = "";

  const flushTurn = (): void => {
    if (turnParts.length === 0) return;
    blocks.push({
      kind: "assistant_turn",
      key: turnKey || `turn-${blocks.length}`,
      parts: turnParts,
    });
    turnParts = [];
    turnKey = "";
  };

  rows.forEach((r, i) => {
    switch (r.kind) {
      case "usage":
        return;
      case "message":
        if (r.msg.role === "user") {
          flushTurn();
          blocks.push({ kind: "message", key: `m-${r.msg.id}`, msg: r.msg });
          return;
        }
        if (!hasVisibleAssistantContent(r.msg.text)) return;
        if (!turnKey) turnKey = `turn-${r.msg.id}`;
        turnParts.push({ kind: "message", msg: r.msg });
        return;
      case "tool": {
        if (toolCategory(r.tool.name) === "plan") return; // the plan card shows it
        if (!turnKey) turnKey = `turn-s-${r.tool.id}`;
        const prev = turnParts[turnParts.length - 1];
        if (prev && prev.kind === "steps") {
          prev.tools.push(r.tool);
        } else {
          turnParts.push({ kind: "steps", tools: [r.tool] });
        }
        return;
      }
      case "plan":
        if (!turnKey) turnKey = `turn-p-${i}`;
        turnParts.push({ kind: "plan", steps: r.steps, latest: i === lastPlanIdx });
        return;
      default:
        if (!turnKey) turnKey = `turn-${r.kind}-${i}`;
        turnParts.push({ kind: "row", row: r });
    }
  });
  flushTurn();
  return blocks;
}

export interface PlanProgress {
  done: number;
  total: number;
  current?: PlanStep;
}

export function planProgress(steps: PlanStep[]): PlanProgress {
  return {
    done: steps.filter((s) => s.status === "completed").length,
    total: steps.length,
    current: steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status === "pending"),
  };
}

export interface TouchedFile {
  path: string;
  kind: "written" | "edited";
 /** How many successful mutations touched it. */
  edits: number;
  added: number;
  removed: number;
  lastAt: number;
}

/** Files the agent created or edited, most recent first. */
export function touchedFiles(rows: Row[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  for (const r of rows) {
    if (r.kind !== "tool" || !r.tool.change || r.tool.status === "error") continue;
    const c = r.tool.change;
    const prev = byPath.get(c.path);
    const { added, removed } = c;
    if (prev) {
      prev.edits += 1;
      prev.added += added;
      prev.removed += removed;
      prev.lastAt = r.at;
    } else {
      byPath.set(c.path, {
        path: c.path,
        kind: c.operation === "write" ? "written" : "edited",
        edits: 1,
        added,
        removed,
        lastAt: r.at,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** Text of the most recent user prompt — what "Retry" resends. */
export function lastUserPrompt(rows: Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "message" && r.msg.role === "user" && r.msg.text.trim() !== "") return r.msg.text;
  }
  return undefined;
}

/** The last running tool, for the "currently doing" line. */
export function currentActivity(rows: Row[]): ToolRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "tool" && r.tool.status === "running") return r.tool;
    if (r.kind === "message" && r.msg.role === "user") return undefined;
  }
  return undefined;
}

/** True once the transcript ends in an unrecovered error (offer Retry). */
export function endsInError(rows: Row[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "usage" || r.kind === "mode") continue;
    return r.kind === "error";
  }
  return false;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export type DateBucket = "Today" | "Yesterday" | "Earlier";

export function dateBucket(ts: number, now = Date.now()): DateBucket {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  if (ts >= t0) return "Today";
  if (ts >= t0 - 86_400_000) return "Yesterday";
  return "Earlier";
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}
