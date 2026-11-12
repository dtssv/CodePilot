// Per-session registry of background sub-agents dispatched with `run:
// "background"`. Unlike bash background jobs (module-global, keyed by cwd), this
// is instantiated ONE PER SESSION and owned by the Session — a shared singleton
// would cross-wire parallel sessions (the same reason the task tool is copied
// per session). Each entry tracks a running `runner.run(...)` promise plus its
// AbortController so the parent can list / wait / interrupt it, and fires a
// one-time completion listener the session turns into a system steer summary.

import type { SubagentRunResult } from "./task.js";

export interface BackgroundSubagentMeta {
  /** The sub-agent's stable id (`sub_…`), the handle for wait / interrupt. */
  sessionId: string;
  objective: string;
  startedAt: number;
  status: "running" | "ok" | "failed" | "interrupted";
  /** Monotonic dispatch sequence (matches the `subagent` event's runSeq). */
  runSeq: number;
  finishedAt?: number;
  /** Short conclusion/summary once finished (for the completion notice). */
  summary?: string;
  steps?: number;
}

interface Entry {
  meta: BackgroundSubagentMeta;
  controller: AbortController;
  /** Resolves when the run settles (for `subagent_wait`). */
  done: Promise<SubagentRunResult>;
}

export type BackgroundCompletionListener = (meta: BackgroundSubagentMeta) => void;

export class BackgroundSubagentRegistry {
  private entries = new Map<string, Entry>();
  private listeners = new Set<BackgroundCompletionListener>();

  /** Register a just-launched background run. `done` is the detached
   * `runner.run(...)` promise; the registry attaches its own settle handler to
   * mark the terminal status and notify listeners exactly once. */
  register(args: {
    sessionId: string;
    objective: string;
    runSeq: number;
    controller: AbortController;
    done: Promise<SubagentRunResult>;
  }): void {
    const meta: BackgroundSubagentMeta = {
      sessionId: args.sessionId,
      objective: args.objective,
      startedAt: Date.now(),
      status: "running",
      runSeq: args.runSeq,
    };
    const entry: Entry = { meta, controller: args.controller, done: args.done };
    this.entries.set(args.sessionId, entry);
    args.done
      .then((r) => this.settle(args.sessionId, r))
      .catch((err) =>
        this.settle(args.sessionId, {
          conclusion: err instanceof Error ? err.message : String(err),
          steps: 0,
          ok: false,
        }),
      );
  }

  private settle(sessionId: string, r: SubagentRunResult): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    const m = entry.meta;
    // An interrupt set the status first; keep it rather than overwriting.
    if (m.status === "running") m.status = r.ok ? "ok" : "failed";
    m.finishedAt = Date.now();
    m.summary = r.conclusion;
    m.steps = r.steps;
    for (const l of this.listeners) {
      try {
        l(m);
      } catch {
        /* a listener must not break settlement */
      }
    }
  }

  /** Subscribe to completion. Returns an unsubscribe. */
  onCompletion(listener: BackgroundCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): BackgroundSubagentMeta[] {
    return [...this.entries.values()].map((e) => ({ ...e.meta }));
  }

  get(sessionId: string): BackgroundSubagentMeta | undefined {
    const e = this.entries.get(sessionId);
    return e ? { ...e.meta } : undefined;
  }

  /** Await a background run's settlement (returns its final meta). Resolves
   * immediately if it already finished; undefined for an unknown id. */
  async wait(sessionId: string): Promise<BackgroundSubagentMeta | undefined> {
    const e = this.entries.get(sessionId);
    if (!e) return undefined;
    await e.done.catch(() => undefined);
    return { ...e.meta };
  }

  /** Abort a running background sub-agent. Marks it interrupted and signals its
   * agent loop to stop. Returns false for an unknown or already-finished id. */
  interrupt(sessionId: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e || e.meta.status !== "running") return false;
    e.meta.status = "interrupted";
    try {
      e.controller.abort();
    } catch {
      /* ignore */
    }
    return true;
  }

  /** Interrupt everything still running (session dispose). */
  interruptAll(): void {
    for (const e of this.entries.values()) {
      if (e.meta.status === "running") {
        e.meta.status = "interrupted";
        try {
          e.controller.abort();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
