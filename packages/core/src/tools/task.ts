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

/** One member of a team (ROADMAP-NEXT §4.2). */
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
  /** Nesting depth: 0 for a top-level task call, 1 for a sub-agent's
   *  task call, etc. The runner refuses to spawn beyond `maxDepth`. */
  depth?: number;
  /** Optional JSON schema the sub-agent's final answer must conform to.
   *  When provided, the runner swaps the free-text conclusion format for
   *  a "return a single JSON object matching this schema" instruction,
   *  parses the final message, and returns the JSON as the conclusion
   *  (wrapped in a ```json fence). The caller can then JSON.parse it. */
  outputSchema?: Record<string, unknown>;
  /** Filesystem isolation. "worktree" creates a linked git worktree and
   *  runs the sub-agent there; "none" (default) runs in the parent cwd.
   *  See ../worktree.ts. */
  isolation?: Isolation;
}

/** Sub-agent filesystem isolation modes. */
export const ISOLATION_MODES = ["none", "worktree"] as const;
export type Isolation = (typeof ISOLATION_MODES)[number];

export interface SubagentRunner {
  run(spec: SubagentRunSpec): Promise<{ conclusion: string; steps: number }>;
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
 *  across all `task` tool invocations in a session so that nested fan-outs
 *  can't exceed the global limit. */
export class Semaphore {  private permits: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) {
      w();
    } else {
      this.permits++;
    }
  }
  /** Run `fn` under the semaphore, always releasing the permit. */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
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
   *  A shared Semaphore enforces this across all task calls. */
  maxThreads?: number;
  /** The semaphore instance (lazily created from maxThreads). */
  _sem?: Semaphore;
} = {
  name: "task",
  description:
    "Dispatch work to sub-agents in isolated contexts. A sub-agent does not see " +
    "your history and you do not see its intermediate steps — only its final " +
    "structured conclusion comes back.\n\n" +
    "When to use: open-ended exploration that would clutter your own context " +
    "('find every callsite of X', 'what does module Y do'), or INDEPENDENT work " +
    "streams you can fan out with `tasks: [...]` — they run in parallel. Choose " +
    "`agent_type: \"worker\"` when the sub-agent must edit files (default " +
    "\"explore\" is read-only).\n" +
    "When NOT to use: a single read_file or one-line grep (do it yourself), or " +
    "serial work whose steps depend on each other.\n" +
    "Write each objective so a fresh agent can act on it with no further context: " +
    "state the goal, the files/areas of interest, and exactly what to return. " +
    "Sub-agents cannot spawn further sub-agents.\n" +
    "Set `isolation: \"worktree\"` when a worker sub-agent will MUTATE files and " +
    "you want its changes fully isolated in a linked git worktree (its own " +
    "checkout + branch, never touching your working tree). Essential for " +
    "parallel fan-outs that each edit files, or for throwaway experiments. " +
    "Requires a git repo; falls back to the parent cwd if git is unavailable. " +
    "The conclusion includes a diff stat of the worktree's changes.\n\n" +
    "CSV batch mode: provide `csv` (a CSV string with a header row) and optional " +
    "`csv_template` to spawn one sub-agent per data row. Column values are " +
    "interpolated into the template by header name (e.g. \"Review {file} for " +
    "security issues\"). Use for repetitive batch work across many items.\n\n" +
    "Team mode: `objective` (the ONE shared goal) + `team: [{role, …}]`. Use when " +
    "the work is a single job that splits by area and the pieces need to be " +
    "reconciled — not for independent errands (that is `tasks`). A `leader` " +
    "investigates and writes each worker's assignment, so you may omit worker " +
    "objectives; members run in parallel and cannot talk to each other. Files " +
    "written by two members are detected and reported as conflicts. " +
    "`merge_strategy` controls the final answer; `shared_worktree: true` keeps all " +
    "edits on an isolated branch. Costs one extra sub-agent run for decomposition " +
    "and one for the merge — prefer `tasks` when you do not need either.",
  inputSchema: schema,
  permission: "execute",
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
        try {
          const r = await sem.withPermit(() => this.runner!.run(spec));
          return { i, ok: true as const, text: r.conclusion, steps: r.steps };
        } catch (err) {
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
