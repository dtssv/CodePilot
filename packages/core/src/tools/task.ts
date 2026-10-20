// task: dispatch sub-tasks to sub-agents. Supports single objective or a
// parallel fan-out (`tasks: [...]`), plus named agent types that control the
// tool surface ("explore" = read-only, "worker" = read+write).
//
// The sub-agent gets a fresh context (does not see the parent's history)
// and returns only its final conclusion. Parallel tasks run concurrently
// via Promise.all; each returns its own structured conclusion.

import { z } from "zod";
import type { Event } from "../types.js";
import type { ToolDef } from "./types.js";

/** Named sub-agent types. "explore" is read-only; "worker" may edit files. */
export const AGENT_TYPES = ["explore", "worker"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

const taskSpec = z.object({
  objective: z.string().describe("Clear, self-contained objective for the sub-agent."),
  agent_type: z
    .string()
    .optional()
    .describe("\"explore\" (default, read-only) or \"worker\" (may edit files), or the name of a custom sub-agent advertised in your system prompt."),
  tools: z
    .array(z.string())
    .optional()
    .describe("Restrict/widen to a subset of tool names."),
  model: z.string().optional().describe("Override the model (default: smallModel)."),
  maxSteps: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum tool steps for the sub-agent (default 15)."),
  output_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "A JSON schema object the sub-agent's final answer must conform to. " +
        "When provided, the sub-agent returns a single JSON object (no markdown) " +
        "and the runner validates + returns it as a fenced ```json block in the " +
        "conclusion. Use this when you need a machine-readable contract (e.g. " +
        "{type:'object',properties:{files:{type:'array',items:{type:'string'}}}}). " +
        "Omit for the default free-text markdown conclusion."
    ),
  isolation: z
    .enum(["none", "worktree"])
    .optional()
    .describe(
      "Filesystem isolation for the sub-agent. \"none\" (default) runs in " +
        "the parent's cwd. \"worktree\" creates a linked git worktree on a " +
        "fresh branch and runs the sub-agent there — its edits land in an " +
        "isolated checkout, never touching the parent's working tree. Use " +
        "\"worktree\" for parallel fan-outs that each mutate files, or for " +
        "experiments you want to discard cleanly. Requires the cwd to be a " +
        "git repo; falls back to \"none\" if git is unavailable."
    ),
});

/** One member of a team. */
const teamMemberSpec = z.object({
  role: z
    .enum(["leader", "worker", "specialist"])
    .describe(
      "\"leader\" splits the goal into assignments and writes the final report " +
        "(read-only, at most one per team); \"worker\" does the work; " +
        "\"specialist\" is a worker with a narrow remit (security, performance…)."
    ),
  objective: z
    .string()
    .optional()
    .describe(
      "What this member does. Omit for workers when the team has a leader — the " +
        "leader then writes the assignment from the team `objective`."
    ),
  name: z
    .string()
    .optional()
    .describe("Display name used in the team log (default \"<role>-<n>\")."),
  agent_type: z
    .string()
    .optional()
    .describe(
      "Sub-agent type, or a custom agent name. Defaults to \"explore\" for a " +
        "leader and \"worker\" for everyone else."
    ),
  tools: z.array(z.string()).optional().describe("Restrict this member's tools."),
  model: z.string().optional().describe("Override this member's model."),
  maxSteps: z.number().int().positive().max(50).optional(),
});

const schema = z
  .object({
    objective: z
      .string()
      .optional()
      .describe("Single-task mode: one self-contained objective."),
    tasks: z
      .array(taskSpec)
      .optional()
      .describe(
        "Fan-out mode: several independent objectives executed IN PARALLEL. " +
          "Each returns its own conclusion. Use for independent explorations."
      ),
    agent_type: z
      .string()
      .optional()
      .describe("Agent type for single-task mode (default \"explore\"). May be a custom agent name."),
    tools: z
      .array(z.string())
      .optional()
      .describe("Tool subset for single-task mode."),
    model: z.string().optional().describe("Model override for single-task mode."),
    maxSteps: z.number().int().positive().max(50).optional(),
    output_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON schema the sub-agent's final answer must conform to (single-task mode)."),
    isolation: z
      .enum(["none", "worktree"])
      .optional()
      .describe("Filesystem isolation for single-task mode (default \"none\")."),
    csv: z
      .string()
      .optional()
      .describe(
        "CSV batch mode: a CSV string (with a header row) where each data row " +
          "becomes a separate sub-agent objective. Combine with `csv_template` " +
          "to control how each row is turned into an objective. The tasks run " +
          "IN PARALLEL (subject to max_threads). Use for repetitive batch work " +
          "across many items (e.g. one row per file, one row per PR). Mutually " +
          "exclusive with `objective` and `tasks`."
      ),
    csv_template: z
      .string()
      .optional()
      .describe(
        "A template string for CSV batch mode. Column values are interpolated " +
          "by header name, e.g. \"Review the file {path} for security issues " +
          "and report findings.\" When omitted, the entire CSV row (joined by " +
          "spaces) is used as the objective."
      ),
    team: z
      .array(teamMemberSpec)
      .optional()
      .describe(
        "Team mode: several agents working on ONE goal (given in `objective`), " +
          "with roles. Unlike `tasks` (independent objectives), a team can have a " +
          "`leader` that splits the goal into assignments, members can share one " +
          "git worktree, edits to the same file by two members are detected and " +
          "reported, and the results are merged per `merge_strategy`. Use for work " +
          "that is one job but splits cleanly by area (frontend/backend/security)."
      ),
    merge_strategy: z
      .enum(["leader_summary", "voting", "concat"])
      .optional()
      .describe(
        "How team results become one answer. \"leader_summary\" (default when the " +
          "team has a leader): the leader writes the report. \"voting\": members " +
          "solved the SAME problem independently and a judge picks the best-supported " +
          "answer. \"concat\" (default without a leader): every conclusion verbatim, " +
          "no extra model call."
      ),
    shared_worktree: z
      .boolean()
      .optional()
      .describe(
        "Run every team member in ONE linked git worktree instead of your working " +
          "tree. Use when the team edits files: their changes land on an isolated " +
          "branch you can review and merge. Requires a git repo; falls back to the " +
          "parent cwd with a note."
      ),
  })
  .refine(
    (v) => {
      const modes = [
 // `objective` doubles as the team goal, so it is not its own mode
 // when `team` is present.
        Boolean(v.objective) && !(v.team && v.team.length > 0),
        Boolean(v.tasks && v.tasks.length > 0),
        Boolean(v.csv),
        Boolean(v.team && v.team.length > 0),
      ];
      return modes.filter(Boolean).length === 1;
    },
    {
      message:
        "provide exactly one of `objective` (single task), `tasks` (fan-out), `csv` (batch), or `team` (team mode, with `objective` as the shared goal)",
    }
  );

export interface SubagentRunSpec {
  objective: string;
  cwd: string;
 /** Built-in type ("explore"|"worker") or custom agent name. */
  agentType?: string;
  tools?: string[];
  model?: string;
  maxSteps?: number;
  onEvent?: (e: Event) => void;
 /** Every sub-agent event as it happens (including failed retry attempts),
 * for live progress UIs. `onEvent` replays only the adopted attempt. */
  onLiveEvent?: (e: Event) => void;
 /** Nesting depth: 0 for a top-level task call, 1 for a sub-agent's
 * task call, etc. The runner refuses to spawn beyond `maxDepth`. */
  depth?: number;
 /** Optional JSON schema the sub-agent's final answer must conform to.
 * When provided, the runner swaps the free-text conclusion format for
 * a "return a single JSON object matching this schema" instruction,
 * parses the final message, and returns the JSON as the conclusion
 * (wrapped in a ```json fence). The caller can then JSON.parse it. */
  outputSchema?: Record<string, unknown>;
 /** Filesystem isolation. "worktree" creates a linked git worktree and
 * runs the sub-agent there; "none" (default) runs in the parent cwd.
 * See ../worktree.ts. */
  isolation?: Isolation;
}

/** Sub-agent filesystem isolation modes. */
export const ISOLATION_MODES = ["none", "worktree"] as const;
export type Isolation = (typeof ISOLATION_MODES)[number];

export interface SubagentRunResult {
  conclusion: string;
  steps: number;
 /**
 * False when the sub-agent soft-failed (provider error, empty final text,
 * etc.) without throwing. Callers must treat `ok: false` as a failed task
 * — do not report it as a successful exploration.
 */
  ok: boolean;
}

export interface SubagentRunner {
  run(spec: SubagentRunSpec): Promise<SubagentRunResult>;
}

/**
 * Minimal CSV parser: handles quoted fields (with embedded commas, quotes
 * escaped as `""`), and CRLF/LF line endings. Returns an array of rows,
 * each row an array of field strings. The first row is the header. Does
 * not handle multi-line quoted fields (rows must be single-line) — this is
 * sufficient for `csv` batch mode where each row is a short objective spec.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }
 // Last field/row.
  if (field !== "" || row.length > 0) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

/** A counting semaphore to cap concurrent sub-agent executions. Shared
 * across all `task` tool invocations in a session so that nested fan-outs
 * can't exceed the global limit. */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void; onAbort?: () => void; signal?: AbortSignal }> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
 /**
 * Acquire a permit. Resolves immediately when one is free, otherwise waits
 * in FIFO order. When `signal` is provided, a waiting acquire rejects (and
 * removes itself from the queue) if the signal aborts — so a cancelled or
 * stuck caller never holds the queue hostage.
 */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("semaphore acquire aborted");
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.waiters)[number];
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("semaphore acquire aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) {
      if (w.onAbort && w.signal) w.signal.removeEventListener("abort", w.onAbort);
      w.resolve();
    } else {
      this.permits++;
    }
  }
 /**
 * Run `fn` under the semaphore, always releasing the permit. An optional
 * `timeoutMs` bounds how long `fn` may run before it is abandoned (the
 * permit is released so other work proceeds); `signal` cancels a queued
 * acquire. A stuck sub-agent therefore cannot starve the rest of the pool.
 */
  async withPermit<T>(fn: () => Promise<T>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    await this.acquire(opts.signal);
    try {
      if (!opts.timeoutMs || opts.timeoutMs <= 0) return await fn();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`sub-agent exceeded ${opts.timeoutMs}ms time budget`)),
          opts.timeoutMs,
        );
      });
      try {
        return await Promise.race([fn(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      this.release();
    }
  }
}

export const taskTool: ToolDef<typeof schema> & {
  runner?: SubagentRunner;
 /** Max sub-agent nesting depth (default 2). Set by the session. */
  maxDepth?: number;
 /** Max concurrently-running sub-agents (default 4). Set by the session.
 * A shared Semaphore enforces this across all task calls. */
  maxThreads?: number;
 /** Optional per-sub-agent wall-clock budget in milliseconds. When set, a
 * sub-agent that runs longer is abandoned and its permit released so the
 * rest of the fan-out proceeds. Unset (default) means no timeout. */
  subagentTimeoutMs?: number;
 /** The semaphore instance (lazily created from maxThreads). */
  _sem?: Semaphore;
} = {
  name: "task",
  description:
    "Run sub-agents in isolated contexts; only their final conclusion returns. " +
    "Use for open-ended exploration or parallel independent work (`tasks: [...]`). " +
    "Default `agent_type: \"explore\"` is read-only; use `\"worker\"` to edit. " +
    "Skip for a single read/grep. Write self-contained objectives. " +
    "`isolation: \"worktree\"` for mutating workers that must not touch the main tree. " +
    "CSV: `csv` + `csv_template` → one agent per row. " +
    "Team: `objective` + `team: [{role,…}]` when roles must be reconciled (else prefer `tasks`).",
  inputSchema: schema,
 // Dispatching is not itself an action: each tool a sub-agent calls goes
 // through the parent's permission engine and prompts (see subagent.ts).
  permission: "read",
  async execute(input, ctx) {
    if (!this.runner) {
      return { content: "subagent runner not configured for this session", isError: true };
    }
 // Recursion guard: refuse to spawn beyond the max nesting depth. The
 // top-level call is depth 0; a sub-agent calling task is depth 1, etc.
 // Default max 2 (parent → subagent → subagent), configurable via the
 // runner's `maxDepth` option (set on the factory).
    const currentDepth = ctx.subagentDepth ?? 0;
    const maxDepth = this.maxDepth ?? 2;
    if (currentDepth >= maxDepth) {
      return {
        content:
          `Refused: sub-agent nesting depth ${currentDepth} would exceed the max ` +
          `depth ${maxDepth}. Sub-agents cannot spawn further sub-agents at this ` +
          `depth — do the work yourself instead of delegating.`,
        isError: true,
      };
    }
 // Concurrency guard: cap the number of sub-agents running at once.
    if (!this._sem) {
      this._sem = new Semaphore(this.maxThreads ?? 4);
    }
    const sem = this._sem;

 // Team mode: one goal, several roles, merged result. See ../teams.ts.
    if (input.team && input.team.length > 0) {
      const { runTeam, renderTeamResult } = await import("../teams.js");
      try {
        const result = await runTeam(
          {
            objective: input.objective,
            members: input.team,
            merge_strategy: input.merge_strategy,
            shared_worktree: input.shared_worktree,
          },
          {
            runner: this.runner,
            cwd: ctx.cwd,
            emitEvent: ctx.emitEvent,
            semaphore: sem,
            depth: currentDepth + 1,
            signal: ctx.signal,
          }
        );
        return {
          content: renderTeamResult(result),
          isError: result.members.every((m) => !m.ok),
        };
      } catch (err) {
        return { content: `team run failed: ${(err as Error).message}`, isError: true };
      }
    }
    const specs: SubagentRunSpec[] = (() => {
 // Fan-out mode: explicit tasks array.
      if (input.tasks && input.tasks.length > 0) {
        return input.tasks.map((t) => ({
          objective: t.objective,
          cwd: ctx.cwd,
          agentType: t.agent_type,
          tools: t.tools,
          model: t.model,
          maxSteps: t.maxSteps,
          depth: currentDepth + 1,
          outputSchema: t.output_schema,
          isolation: t.isolation,
        }));
      }
 // CSV batch mode: each data row becomes a sub-agent objective.
      if (input.csv) {
        const rows = parseCsv(input.csv);
        if (rows.length === 0) return [];
        const headers = rows[0]!;
        const template = input.csv_template;
        return rows.slice(1).map((row) => {
          const colMap = new Map<string, string>();
          headers.forEach((h, i) => colMap.set(h, row[i] ?? ""));
          const objective = template
            ? template.replace(/\{(\w+)\}/g, (_, key) => colMap.get(String(key)) ?? "")
            : row.join(" ");
          return {
            objective,
            cwd: ctx.cwd,
            agentType: input.agent_type,
            tools: input.tools,
            model: input.model,
            maxSteps: input.maxSteps,
            depth: currentDepth + 1,
            outputSchema: input.output_schema,
            isolation: input.isolation,
          };
        });
      }
 // Single-task mode.
      return [
        {
          objective: input.objective!,
          cwd: ctx.cwd,
          agentType: input.agent_type,
          tools: input.tools,
          model: input.model,
          maxSteps: input.maxSteps,
          depth: currentDepth + 1,
          outputSchema: input.output_schema,
          isolation: input.isolation,
        },
      ];
    })();
    const results = await Promise.all(
      specs.map(async (spec, i) => {
        const progress = (extra: { state?: "running" | "ok" | "failed"; event?: Event }): void => {
          if (!ctx.emitEvent || !ctx.toolCallId) return;
          void Promise.resolve(
            ctx.emitEvent({
              type: "subagent",
              parentToolCallId: ctx.toolCallId,
              index: i,
              objective: spec.objective,
              ts: Date.now(),
              ...extra,
            }),
          ).catch(() => {});
        };
        progress({ state: "running" });
        try {
          const r = await sem.withPermit(
            () => this.runner!.run({ ...spec, onLiveEvent: (event) => progress({ event }) }),
            { signal: ctx.signal, timeoutMs: this.subagentTimeoutMs },
          );
          progress({ state: r.ok ? "ok" : "failed" });
 // Honour the runner's soft-failure flag (empty conclusion /
 // provider error). Previously we marked every non-throwing run
 // as ok, so "Model not exist" sub-agents looked like successful
 // 0-step explorations.
          return { i, ok: r.ok, text: r.conclusion, steps: r.steps };
        } catch (err) {
          progress({ state: "failed" });
          return { i, ok: false as const, text: (err as Error).message, steps: 0 };
        }
      })
    );
    if (results.length === 0) {
      return { content: "No tasks to run (CSV had no data rows or tasks array was empty).", isError: true };
    }
    if (results.length === 1) {
      const r = results[0]!;
      return r.ok
        ? { content: `sub-agent completed in ${r.steps} step(s). Conclusion:\n\n${r.text}` }
        : { content: `sub-agent failed: ${r.text}`, isError: true };
    }
    const body = results
      .map(
        (r) =>
          `### Task ${r.i + 1} ${r.ok ? `(${r.steps} steps)` : "(FAILED)"}\n\n${r.text}`
      )
      .join("\n\n---\n\n");
    return {
      content: `${results.length} sub-agents finished (${results.filter((r) => r.ok).length} ok).\n\n${body}`,
      isError: results.some((r) => !r.ok),
    };
  },
};
