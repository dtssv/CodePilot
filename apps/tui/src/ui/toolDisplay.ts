/**
 * How a tool call reads in the transcript and the detail viewer: a short
 * label, its subject (command / path / pattern…), a few preview lines of the
 * result and, for edits, a compact diff. Pure so it can be unit-tested.
 */
import type { ToolRow } from "./state.js";
import { toolTarget } from "./theme.js";

export function toolLabel(tool: Pick<ToolRow, "name" | "category" | "input">): string {
  const n = tool.name;
  // apply_patch: label by what the patch does, not the tool name.
  if (n === "apply_patch" && tool.input && typeof tool.input === "object") {
    const patch = (tool.input as Record<string, unknown>).patch;
    if (typeof patch === "string") {
      const touches = patch
        .split(/\r?\n/)
        .map((line) => {
          if (line.startsWith("*** Add File: ")) return "add" as const;
          if (line.startsWith("*** Update File: ")) return "update" as const;
          if (line.startsWith("*** Delete File: ")) return "delete" as const;
          return null;
        })
        .filter((x): x is "add" | "update" | "delete" => x !== null);
      if (touches.length > 0 && touches.every((t) => t === "add")) return "Write";
      if (touches.length > 0 && touches.every((t) => t === "delete")) return "Delete";
      if (touches.length > 0) return "Update";
    }
  }
  switch (tool.category) {
    case "bash":
      return n === "bash_output" ? "Shell output" : n === "bash_kill" ? "Stop shell" : n === "write_stdin" ? "Shell input" : "Bash";
    case "read":
      return "Read";
    case "list":
      return "List";
    case "search":
      return n === "glob" ? "Glob" : n === "grep" ? "Grep" : "Search";
    case "edit":
      return "Update";
    case "write":
      return "Write";
    case "web":
      return n === "web_search" ? "Web search" : "Fetch";
    case "task": {
      if (n === "skill") return "Skill";
      if (n === "team") return "Team";
      const action = (tool.input as { action?: string } | undefined)?.action;
      if (action === "wait") return "Wait subtask";
      if (action === "interrupt") return "Interrupt subtask";
      if (action === "list") return "List subtasks";
      return "Task";
    }
    case "memory":
      return "Memory";
    case "plan":
      return (tool.input as { action?: string } | undefined)?.action === "done"
        ? "Plan ready"
        : "Plan";
    case "ask":
      return "Question";
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(n);
      return mcp ? `${mcp[1]} · ${mcp[2]}` : n;
    }
  }
}

function field(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** The command for shell tools, verbatim (newlines kept). */
export function bashCommand(tool: Pick<ToolRow, "input">): string | undefined {
  return field(tool.input, "command", "cmd");
}

/** What the call acts on, on one line. */
export function toolSubject(tool: Pick<ToolRow, "name" | "category" | "input" | "target">): string {
  if (tool.category === "task") {
    const action = field(tool.input, "action");
    if (action === "wait" || action === "interrupt") {
      return (field(tool.input, "session_id") ?? tool.target).replace(/\s+/g, " ").trim();
    }
    if (action === "list") return "list";
    const objective = field(tool.input, "objective", "description", "prompt", "name") ?? tool.target;
    return objective.replace(/\s+/g, " ").trim();
  }
  if (tool.category === "bash") return (bashCommand(tool) ?? tool.target).trim();
  // Recompute from input so apply_patch shows files even when `target` was
  // empty (older sessions) or only held a truncated summary.
  return toolTarget(tool.input) || tool.target;
}

/** Sub-agent flavour for task calls ("explore", "worker"…), if given. */
export function agentType(tool: Pick<ToolRow, "input">): string | undefined {
  return field(tool.input, "agent_type", "subagent_type", "agent", "type");
}

export function outputLines(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map((l) => l.trimEnd());
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

export interface Preview {
  lines: string[];
  /** Lines not shown in the preview (viewer has them). */
  hidden: number;
  tone: "normal" | "error" | "faint";
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Result preview under a finished tool row. */
export function resultPreview(tool: ToolRow, max = 4): Preview {
  const lines = outputLines(tool.resultText);
  if (tool.status === "error") {
    const shown = lines.slice(0, Math.max(max, 6));
    return { lines: shown.length ? shown : ["(failed with no output)"], hidden: lines.length - shown.length, tone: "error" };
  }
  switch (tool.category) {
    case "bash": {
      if (lines.length === 0) return { lines: ["(no output)"], hidden: 0, tone: "faint" };
      const shown = lines.slice(0, max);
      return { lines: shown, hidden: lines.length - shown.length, tone: "normal" };
    }
    case "read":
      return { lines: [`Read ${plural(lines.length, "line")}`], hidden: 0, tone: "faint" };
    case "list":
      return { lines: [plural(lines.filter((l) => l.trim()).length, "entry", "entries")], hidden: 0, tone: "faint" };
    case "search": {
      const hits = lines.filter((l) => l.trim()).length;
      return { lines: [hits === 0 ? "No matches" : plural(hits, "result")], hidden: 0, tone: "faint" };
    }
    case "edit":
    case "write":
    case "plan":
    case "task":
      return { lines: [], hidden: 0, tone: "faint" };
    default: {
      const shown = lines.slice(0, 2);
      return { lines: shown, hidden: lines.length - shown.length, tone: "faint" };
    }
  }
}

export interface DiffLine {
  sign: "+" | "-" | " ";
  text: string;
}

function editPairs(input: unknown): { before: string; after: string }[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const pairs: { before: string; after: string }[] = [];
  const one = (e: Record<string, unknown>): void => {
    const before = e.search ?? e.old_string ?? e.old_str;
    const after = e.replace ?? e.new_string ?? e.new_str;
    if (typeof before === "string" || typeof after === "string") {
      pairs.push({ before: typeof before === "string" ? before : "", after: typeof after === "string" ? after : "" });
    }
  };
  one(o);
  if (Array.isArray(o.edits)) for (const e of o.edits) if (e && typeof e === "object") one(e as Record<string, unknown>);
  return pairs;
}

/** A compact diff for edit/write calls, built from the tool input. */
export function editDiff(tool: Pick<ToolRow, "category" | "input">, max = 12): { lines: DiffLine[]; hidden: number } {
  const out: DiffLine[] = [];
  if (tool.category === "write") {
    const content = field(tool.input, "content");
    for (const l of outputLines(content)) out.push({ sign: "+", text: l });
  } else if (tool.category === "edit") {
    for (const { before, after } of editPairs(tool.input)) {
      const a = before.replace(/\n$/, "").split("\n");
      const b = after.replace(/\n$/, "").split("\n");
      let head = 0;
      while (head < a.length && head < b.length && a[head] === b[head]) head++;
      let tail = 0;
      while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
      if (head > 0) out.push({ sign: " ", text: a[head - 1]! });
      for (const l of a.slice(head, a.length - tail)) out.push({ sign: "-", text: l });
      for (const l of b.slice(head, b.length - tail)) out.push({ sign: "+", text: l });
      if (tail > 0) out.push({ sign: " ", text: a[a.length - tail]! });
    }
  }
  return { lines: out.slice(0, max), hidden: Math.max(0, out.length - max) };
}
