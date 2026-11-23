// task: dispatch sub-tasks to sub-agents. Supports a single objective or a
// parallel fan-out (`tasks: [...]`), plus named agent types that control the
// tool surface ("explore"/"plan" = read-only, "worker" = read+write). A sub-agent
// returns only its final conclusion; `context: "fork"` seeds it with the
// parent's history. Single-task mode can run in the background.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Event, UsageInfo } from "../types.js";
import type { ToolDef } from "./types.js";
import { isTransientError } from "../agent/transientError.js";
import { BackgroundSubagentRegistry } from "./subagentJobs.js";
import { spillHeadTail } from "./_shared.js";

/** Named sub-agent types. "explore" and "plan" are read-only; "worker" may
 * edit files. "plan" additionally structures its output as a plan. */
export const AGENT_TYPES = ["explore", "plan", "worker"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** Shared agent_type field — keep one copy (not 3× in nested specs). */
const agentTypeField = z
  .string()
  .optional()
  .describe(
    "explore (default: read_file/grep/glob/ls/web_*, no bash) | plan (same, read-only) | " +
      "worker (bash+writes) | custom. Need shell/mutate → worker.",
  );

const toolsNarrowField = z
  .array(z.string())
  .optional()
  .describe(
    "Narrow the agent_type pool only. Out-of-pool names are ignored (not an error); " +
      "explore/plan never gain bash via this list.",
  );

const taskSpec = z.object({
  objective: z.string().describe("Self-contained objective."),
  agent_type: agentTypeField,
  tools: toolsNarrowField,
  model: z.string().optional().describe("Model override."),
  maxSteps: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Turn cap (default 40 when omitted)."),
  output_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema for a machine-readable final answer."),
  isolation: z.enum(["none", "worktree"]).optional().describe("none (default) | worktree."),
});

/** One member of a team. */
const teamMemberSpec = z.object({
  role: z.enum(["leader", "worker", "specialist"]).describe("leader | worker | specialist."),
  objective: z.string().optional().describe("Member objective; leader may assign if omitted."),
  name: z.string().optional().describe("Display name."),
  agent_type: agentTypeField,
  tools: toolsNarrowField,
  model: z.string().optional().describe("Model override."),
  maxSteps: z.number().int().positive().max(1000).optional(),
});

const schema = z
  .object({
    action: z
      .enum(["list", "wait", "interrupt"])
      .optional()
      .describe(
        "Background-subagent control (no spawn): list | wait | interrupt. " +
          "Requires `session_id` for wait/interrupt. Omit to dispatch a sub-agent.",
      ),
    session_id: z
      .string()
      .optional()
      .describe("Background sub-agent id for action=wait|interrupt."),
    objective: z.string().optional().describe("Single-task or team goal."),
    tasks: z.array(taskSpec).optional().describe("Parallel independent objectives (fan-out)."),
    agent_type: agentTypeField,
    tools: toolsNarrowField,
    model: z.string().optional().describe("Model override (single-task)."),
    maxSteps: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Turn cap (default 40 when omitted)."),
    output_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema for the final answer (single-task)."),
    isolation: z.enum(["none", "worktree"]).optional().describe("none (default) | worktree (git only — not tools)."),
    run: z
      .enum(["await", "background"])
      .optional()
      .describe("await (default) | background (then list/wait/interrupt via action)."),
    context: z
      .enum(["fresh", "fork"])
      .optional()
      .describe("fresh (default) | fork parent history. Not with continue_session_id."),
    fork_max_tokens: z.number().int().positive().optional().describe("Token cap on forked history."),
    omit_memory: z
      .boolean()
      .optional()
      .describe("omit_memory: true — drop project/user memory (audit / clean-room / ignore prior notes)."),
    continue_session_id: z.string().optional().describe("Resume a prior sub-agent session_id (single-task)."),
    csv: z.string().optional().describe("CSV batch (header + rows); exclusive with objective/tasks."),
    csv_template: z.string().optional().describe('Row→objective template, e.g. "Review {path}".'),
    team: z.array(teamMemberSpec).optional().describe("Role-based team on one objective (vs independent tasks)."),
    merge_strategy: z
      .enum(["leader_summary", "voting", "concat"])
      .optional()
      .describe("How team conclusions merge."),
    shared_worktree: z.boolean().optional().describe("One shared worktree for the whole team."),
    team_board: z.boolean().optional().describe("Seed task_board from leader assignments."),
  })
  .superRefine((v, ctx) => {
    if (v.action === "wait" || v.action === "interrupt") {
      if (!v.session_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `action=${v.action} requires session_id`,
          path: ["session_id"],
        });
      }
      return;
    }
    if (v.action === "list") return;
    const modes = [
      Boolean(v.objective) && !(v.team && v.team.length > 0),
      Boolean(v.tasks && v.tasks.length > 0),
      Boolean(v.csv),
      Boolean(v.team && v.team.length > 0),
    ];
    if (modes.filter(Boolean).length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "provide exactly one of `objective` (single task), `tasks` (fan-out), `csv` (batch), or `team` " +
          "(team mode, with `objective` as the shared goal) — or use action=list|wait|interrupt",
      });
    }
  })
  .refine((v) => !(v.context === "fork" && v.continue_session_id), {
    message: '`context: "fork"` and `continue_session_id` are mutually exclusive.',
  });

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
 /** Continue an EXISTING sub-agent instead of spawning a fresh one. When set,
  * the runner loads that sub-agent's stored transcript as history and sends
  * `objective` (or `continueText`) as a follow-up — the sub-agent keeps its
  * full conversation. The id is the `sessionId` a prior run returned. */
  resumeSessionId?: string;
 /** When "fork", the runner seeds the sub-agent with a copy of the parent's
  * model-visible history (via {@link SubagentFactoryOptions.getParentEvents})
  * as a prefix before the objective, so it inherits what the parent has read.
  * "fresh" (default) starts empty. Mutually exclusive with resumeSessionId. */
  context?: "fresh" | "fork";
 /** When forking, hard-cap the inherited history to this many estimated tokens
  * (older turns folded/trimmed). Omit for the runner's default. */
  forkMaxTokens?: number;
 /** When true, the sub-agent's system prompt omits the project/user memory
  * index (used by a focused `plan` sub-agent, or any caller that wants the
  * agent to reason only from the objective + what it reads). */
  omitMemory?: boolean;
 /** The follow-up message when continuing (defaults to `objective`). Sent
  * WITHOUT the "you are a sub-agent" preamble — the resumed agent already has
  * that context. */
  continueText?: string;
 /** The sub-agent's stable id. Set by the `task` tool so the id in the
  * progress events, the persisted transcript, and the returned
  * `session_id` all match. When omitted the runner generates one. */
  ownerId?: string;
  /** A pre-created shared worktree the sub-agent runs inside without creating
   * its own (used by `team` with `shared_worktree`). When set, the runner
   * re-anchors sandbox + delivery roots to this path so writes to the shared
   * checkout aren't rejected as out-of-root. `isolation` stays "none". */
  sharedWorktreePath?: string;
 /** External abort signal for this run. Threaded into the sub-agent's agent
  * loop so a background job can be interrupted via `subagent_interrupt`. When
  * aborted, the run stops at the next loop checkpoint and returns a blocker. */
  signal?: AbortSignal;
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
 /** Token usage for the adopted attempt only (retries excluded). Tracked
 * separately during the run; callers should roll this into the parent
 * after the sub-agent finishes. */
  usage?: UsageInfo;
 /** The sub-agent's stable, unique run id (`sub_…`). The parent surfaces this
  * so a later `task` call can pass it as `continue_session_id` to continue
  * the SAME sub-agent instead of dispatching a new one. */
  sessionId?: string;
 /** True when the run hit its configured turn/step cap (after soft-land).
  * Parent should resume via continue_session_id if more work is needed. */
  reachedTurnBudget?: boolean;
}

/** Emit sub-agent usage onto the parent event stream so session totals
 * include it after the child completes. Nested under a parent sub-agent,
 * this lands in that child's transcript and is summed into its result. */
export function emitParentUsage(
  emitEvent: ((e: Event) => void | Promise<void>) | undefined,
  usage: UsageInfo | undefined,
): void {
  if (!emitEvent || !usage) return;
  if (usage.input <= 0 && usage.output <= 0) return;
  void Promise.resolve(
    emitEvent({ type: "usage", usage, rollup: true, ts: Date.now() }),
  ).catch(() => {});
}

export interface SubagentRunner {
  run(spec: SubagentRunSpec): Promise<SubagentRunResult>;
}

/**
 * Minimal CSV parser: quoted fields (commas embedded, `""` escapes), CRLF/LF.
 * First row is the header. No multi-line quoted fields (rows must be
 * single-line) — sufficient for `csv` batch mode.
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
 * Acquire a permit: immediate when free, otherwise FIFO-queued. A provided
 * `signal` makes a waiting acquire reject (and dequeue) on abort, so a
 * cancelled/stuck caller never holds the queue hostage.
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
 * Run `fn` under the semaphore, always releasing the permit. `timeoutMs`
 * bounds `fn`'s runtime (permit released on timeout so others proceed);
 * `signal` cancels a queued acquire. A stuck sub-agent can't starve the pool.
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
 /** Max sub-agent nesting depth (default 3). Set by the session. */
  maxDepth?: number;
 /** Max concurrently-running sub-agents (default 6). Set by the session.
 * A shared Semaphore enforces this across all task calls. */
  maxThreads?: number;
 /** Max total sub-agents a session may spawn across the whole run (default
 * 200). Guards against runaway累计 fan-out even when depth/concurrency are
 * within bounds. Enforced via the shared `_spawned` counter. */
  maxTotal?: number;
 /** Optional per-sub-agent wall-clock budget in milliseconds. When set, a
 * sub-agent that runs longer is abandoned and its permit released so the
 * rest of the fan-out proceeds. Unset (default) means no timeout. */
  subagentTimeoutMs?: number;
 /** The semaphore instance (lazily created from maxThreads). */
  _sem?: Semaphore;
 /** Running total of sub-agents spawned this session (for maxTotal). */
  _spawned?: number;
 /** Session-global monotonic counter so every dispatched sub-agent gets a
  * unique display sequence (`#3`), unlike the per-fan-out `index`. */
  _runSeq?: number;
 /** Per-session registry of background sub-agents (`run: "background"`). Set by
  * the session; also read by the `subagent_list`/`wait`/`interrupt` control
  * tools. Absent → background dispatch is unavailable (falls back to await). */
  backgroundRegistry?: BackgroundSubagentRegistry;
} = {
  name: "task",
  description:
    "Dispatch a sub-agent; only its final conclusion returns. " +
    "**When:** broad multi-hop search, parallel independent workstreams, or the user asked for a subagent/`task`. " +
    "**When not:** a single read/grep/one-file fix — do that yourself. " +
    "**Briefing:** write the objective as if they have zero chat context — paths/lines, what you already ruled out, and the acceptance bar. " +
    "Never \"based on your findings, fix…\" (you synthesise; they search or execute). " +
    "Modes: `objective` (one), `tasks` (parallel), `csv`+`csv_template`, or `objective`+`team`. " +
    "Background control: `action: list|wait|interrupt` (+ `session_id` for wait/interrupt). " +
    "agent_type: explore | plan | worker — `tools` narrows only (cannot grant parent-only tools). " +
    "Knobs: isolation=worktree (git only), context=fresh|fork (`fork_max_tokens`), " +
    "omit_memory: true, run=background, continue_session_id. Pool: `subagentMaxThreads` (default 6).",
  inputSchema: schema,
 // Dispatching is not itself an action: each tool a sub-agent calls goes
 // through the parent's permission engine and prompts (see subagent.ts).
  permission: "read",
  async execute(input, ctx) {
    if (input.action === "list" || input.action === "wait" || input.action === "interrupt") {
      const {
        executeSubagentList,
        executeSubagentWait,
        executeSubagentInterrupt,
      } = await import("./subagentControl.js");
      const reg = this.backgroundRegistry;
      if (!reg) {
        return {
          content: "background sub-agent registry is not available in this session",
          isError: true,
        };
      }
      if (input.action === "list") return executeSubagentList(reg);
      if (input.action === "wait") return executeSubagentWait(reg, input.session_id!);
      return executeSubagentInterrupt(reg, input.session_id!);
    }

    if (!this.runner) {
      return { content: "subagent runner not configured for this session", isError: true };
    }
 // Recursion guard: refuse to spawn beyond the max nesting depth. The
 // top-level call is depth 0; a sub-agent calling task is depth 1, etc.
 // Default max 3 (coordinator → orchestrator → worker), configurable via the
 // runner's `maxDepth` option (set on the factory).
    const currentDepth = ctx.subagentDepth ?? 0;
    const maxDepth = this.maxDepth ?? 3;
    if (currentDepth >= maxDepth) {
      return {
        content:
          `Refused: sub-agent nesting depth ${currentDepth} would exceed the max ` +
          `depth ${maxDepth}. Sub-agents cannot spawn further sub-agents at this ` +
          `depth — do the work yourself instead of delegating.`,
        isError: true,
      };
    }
    // `context: "fork"` inherits the parent conversation; `continue_session_id`
    // resumes a sub-agent that already has its own — they can't both apply.
    if (input.context === "fork" && input.continue_session_id) {
      return {
        content:
          "Refused: `context: \"fork\"` and `continue_session_id` are mutually " +
          "exclusive. Fork to seed a new sub-agent with this conversation, or " +
          "continue an existing one — not both.",
        isError: true,
      };
    }
 // Concurrency guard: cap the number of sub-agents running at once.
    if (!this._sem) {
      this._sem = new Semaphore(this.maxThreads ?? 6);
    }
    const sem = this._sem;

    // Total-spawn guard shared by the team and fan-out paths: `tryReserve`
    // checks the cumulative `_spawned` counter against `maxTotal`. Fan-out
    // trims to fit; a team roster is atomic and refuses wholesale on overflow.
    const maxTotal = this.maxTotal ?? 200;
    const tryReserve = (want: number): number => {
      const already = this._spawned ?? 0;
      const grant = Math.max(0, Math.min(want, maxTotal - already));
      this._spawned = already + grant;
      return grant;
    };

    // Background dispatch (single-task mode): launch detached, return a handle
    // immediately, deliver a one-time completion summary later. Fan-out/team/csv
    // always await. A permit + spawn slot are held for the run's real lifetime
    // and released on settle.
    if (
      input.run === "background" &&
      input.objective &&
      !(input.team && input.team.length > 0) &&
      !input.tasks &&
      !input.csv
    ) {
      const registry = this.backgroundRegistry;
      if (!registry) {
        return {
          content:
            "Background dispatch is not available in this context; run the task " +
            "normally (omit `run: \"background\"`).",
          isError: true,
        };
      }
      if (tryReserve(1) < 1) {
        return {
          content:
            `Refused: this session has already spawned ${this._spawned ?? 0} ` +
            `sub-agents, reaching the cap of ${maxTotal}.`,
          isError: true,
        };
      }
      const runSeq = (this._runSeq = (this._runSeq ?? 0) + 1);
      const ownerId = input.continue_session_id ?? `sub_${randomUUID()}`;
      // Abort wire for `subagent_interrupt`. Independent of the parent turn's
      // signal: a background job outlives the turn that dispatched it.
      const controller = new AbortController();
      const progress = (extra: {
        state?: "running" | "ok" | "failed" | "interrupted";
        event?: Event;
      }): void => {
        if (!ctx.emitEvent || !ctx.toolCallId) return;
        void Promise.resolve(
          ctx.emitEvent({
            type: "subagent",
            parentToolCallId: ctx.toolCallId,
            index: 0,
            objective: input.objective!,
            sessionId: ownerId,
            runSeq,
            background: true,
            ts: Date.now(),
            ...extra,
          }),
        ).catch(() => {});
      };
      progress({ state: "running" });
      const spec: SubagentRunSpec = {
        objective: input.objective,
        cwd: ctx.cwd,
        agentType: input.agent_type,
        tools: input.tools,
        model: input.model,
        maxSteps: input.maxSteps,
        depth: currentDepth + 1,
        outputSchema: input.output_schema,
        isolation: input.isolation,
        resumeSessionId: input.continue_session_id,
        context: input.context,
        forkMaxTokens: input.fork_max_tokens,
        omitMemory: input.omit_memory,
        ownerId,
        signal: controller.signal,
      };
      // Detached run: hold a permit for its real lifetime (not the parent turn),
      // release the spawn slot + permit on settle, and relay progress events.
      const done = sem
        .withPermit(
          () =>
            this.runner!.run({
              ...spec,
              onLiveEvent: (event) => progress({ event }),
            }),
          { signal: controller.signal, timeoutMs: this.subagentTimeoutMs },
        )
        .then((r) => {
          progress({ state: controller.signal.aborted ? "interrupted" : r.ok ? "ok" : "failed" });
          emitParentUsage(ctx.emitEvent, r.usage);
          return r;
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          progress({ state: controller.signal.aborted ? "interrupted" : "failed" });
          return { conclusion: msg, steps: 0, ok: false as const };
        });
      registry.register({ sessionId: ownerId, objective: input.objective, runSeq, controller, done });
      return {
        content:
          `Background sub-agent started.\n\n` +
          `session_id: ${ownerId}\nstatus: running\n\n` +
          `It runs independently; you will get a one-time completion summary when ` +
          `it finishes. Use task({ action: "list" }) to check, ` +
          `task({ action: "wait", session_id }) to block, or ` +
          `task({ action: "interrupt", session_id }) to stop it.`,
      };
    }

 // Team mode: one goal, several roles, merged result. See ../teams.ts.
    if (input.team && input.team.length > 0) {
      // A team dispatches its members (plus at most an internal leader/merger,
      // which are bounded and not user-controlled); the members are the fan-out
      // that the cap exists to bound, so count the roster against maxTotal.
      const granted = tryReserve(input.team.length);
      if (granted < input.team.length) {
        // Roll back the partial reservation — teams run whole or not at all.
        this._spawned = (this._spawned ?? 0) - granted;
        return {
          content:
            `Refused: this session has already spawned ${this._spawned ?? 0} sub-agents; ` +
            `a team of ${input.team.length} would exceed the cap of ${maxTotal}. ` +
            `Reconcile the remaining work directly instead of delegating further.`,
          isError: true,
        };
      }
      const { runTeam, renderTeamResult } = await import("../subagent/teams.js");
      try {
        const result = await runTeam(
          {
            objective: input.objective,
            members: input.team,
            merge_strategy: input.merge_strategy,
            shared_worktree: input.shared_worktree,
            team_board: input.team_board,
          },
          {
            runner: this.runner,
            cwd: ctx.cwd,
            emitEvent: ctx.emitEvent,
            semaphore: sem,
            depth: currentDepth + 1,
            signal: ctx.signal,
            projectStateDir: ctx.projectStateDir,
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
          resumeSessionId: input.continue_session_id,
          context: input.context,
          forkMaxTokens: input.fork_max_tokens,
          omitMemory: input.omit_memory,
        },
      ];
    })();
    // Total-spawn guard (shared with the team path above): cap cumulative
    // sub-agents across the whole session so a deep/wide tree can't fork-bomb
    // the token budget. Enforced on top of depth + concurrency (the two
    // independent brakes). A fan-out trims to fit under the cap rather than
    // rejecting wholesale.
    const alreadySpawned = this._spawned ?? 0;
    if (alreadySpawned >= maxTotal) {
      return {
        content:
          `Refused: this session has already spawned ${alreadySpawned} sub-agents, ` +
          `reaching the cap of ${maxTotal}. Do the remaining work directly ` +
          `instead of delegating further.`,
        isError: true,
      };
    }
    const granted = tryReserve(specs.length);
    if (granted < specs.length) {
      specs.length = granted;
    }
    const results = await Promise.all(
      specs.map(async (spec, i) => {
        // Session-global unique sequence for this dispatch (for UI labels).
        const runSeq = (this._runSeq = (this._runSeq ?? 0) + 1);
        // The sub-agent's stable id: a resumed run keeps its id; a fresh run
        // gets one now so the progress events (and the parent's returned
        // `session_id`) carry it from the very first "running" marker.
        const ownerId = spec.resumeSessionId ?? `sub_${randomUUID()}`;
        const progress = (extra: { state?: "running" | "ok" | "failed"; event?: Event }): void => {
          if (!ctx.emitEvent || !ctx.toolCallId) return;
          void Promise.resolve(
            ctx.emitEvent({
              type: "subagent",
              parentToolCallId: ctx.toolCallId,
              index: i,
              objective: spec.objective,
              sessionId: ownerId,
              runSeq,
              ts: Date.now(),
              ...extra,
            }),
          ).catch(() => {});
        };
        progress({ state: "running" });
        // Self-heal: retry a transient failure once (rate-limit / overloaded /
        // timeout / network). Deterministic failures (bad model, empty result)
        // are not retried. Uses the shared classifier so the sub-agent retry
        // policy matches the agent loop's. Resume an existing run via
        // continue_session_id — do not memoize conclusions by objective.
        const isTransient = isTransientError;
        const runOnce = () =>
          sem.withPermit(
            () => this.runner!.run({ ...spec, ownerId, onLiveEvent: (event) => progress({ event }) }),
            { signal: ctx.signal, timeoutMs: this.subagentTimeoutMs },
          );
        try {
          let r = await runOnce();
          if (!r.ok && isTransient(r.conclusion ?? "") && !ctx.signal?.aborted) {
            r = await runOnce();
          }
          progress({ state: r.ok ? "ok" : "failed" });
          // Roll sub-agent tokens into the parent only after it finishes.
          emitParentUsage(ctx.emitEvent, r.usage);
 // Honour the runner's soft-failure flag (empty conclusion /
 // provider error). Previously we marked every non-throwing run
 // as ok, so "Model not exist" sub-agents looked like successful
 // 0-step explorations.
          return {
            i,
            ok: r.ok,
            text: r.conclusion,
            steps: r.steps,
            sessionId: r.sessionId ?? ownerId,
            reachedTurnBudget: r.reachedTurnBudget === true,
          };
        } catch (err) {
          const msg = (err as Error).message;
          // One retry for transient throws too (e.g. timeout rejection).
          if (isTransient(msg) && !ctx.signal?.aborted) {
            try {
              const r = await runOnce();
              progress({ state: r.ok ? "ok" : "failed" });
              emitParentUsage(ctx.emitEvent, r.usage);
              return {
                i,
                ok: r.ok,
                text: r.conclusion,
                steps: r.steps,
                sessionId: r.sessionId ?? ownerId,
                reachedTurnBudget: r.reachedTurnBudget === true,
              };
            } catch (err2) {
              progress({ state: "failed" });
              return {
                i,
                ok: false as const,
                text: (err2 as Error).message,
                steps: 0,
                sessionId: ownerId,
                reachedTurnBudget: false,
              };
            }
          }
          progress({ state: "failed" });
          return {
            i,
            ok: false as const,
            text: msg,
            steps: 0,
            sessionId: ownerId,
            reachedTurnBudget: false,
          };
        }
      })
    );
    if (results.length === 0) {
      return { content: "No tasks to run (CSV had no data rows or tasks array was empty).", isError: true };
    }
    if (results.length === 1) {
      const r = results[0]!;
      // Surface the sub-agent's session_id so a follow-up can continue the SAME
      // sub-agent via `continue_session_id` instead of spawning a fresh one.
      const handle = r.sessionId
        ? ` session_id: ${r.sessionId} (pass as continue_session_id to continue this sub-agent)`
        : "";
      const budgetNote = r.reachedTurnBudget ? " [turn budget reached]" : "";
      const raw = r.ok
        ? `sub-agent completed in ${r.steps} step(s).${budgetNote}${handle}\n\nConclusion:\n\n${r.text}`
        : `sub-agent failed${budgetNote}: ${r.text}${handle}`;
      const spilled = await spillHeadTail(ctx, raw, `task:${r.sessionId ?? r.i}`);
      return {
        content: spilled.content,
        isError: !r.ok,
        artifactRef: spilled.artifactRef,
      };
    }
    const body = results
      .map(
        (r) =>
          `### Task ${r.i + 1} ${r.ok ? `(${r.steps} steps)` : "(FAILED)"}\n\n${r.text}`
      )
      .join("\n\n---\n\n");
    const raw = `${results.length} sub-agents finished (${results.filter((r) => r.ok).length} ok).\n\n${body}`;
    const spilled = await spillHeadTail(ctx, raw, `task:fanout:${results.length}`);
    return {
      content: spilled.content,
      isError: results.some((r) => !r.ok),
      artifactRef: spilled.artifactRef,
    };
  },
};
