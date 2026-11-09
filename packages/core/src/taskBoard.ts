// Shared task board for coordinating parallel sub-agents.
//
// A single append-only JSONL file at `<projectStateDir>/taskboard.jsonl`,
// mirroring the session-level event-sourcing model (one file, single-writer
// append + replay). The board is a DERIVED view: the JSONL log of entries is
// the source of truth, and the task snapshot is recomputed by folding the log
// at read time. The file may be deleted at any time — a missing/corrupt file
// just yields an empty board.
//
// Ownership is single-writer-per-task: a task is claimed by exactly one owner,
// and only that owner may complete or update it. Claiming an already-claimed
// task fails (the loser does other work). This gives parallel sub-agents a
// contention-safe way to divide labour without a central coordinator.
//
// Everything is best-effort and fail-soft: the board is a coordination aid,
// never a blocker. A failed append simply means the entry was not recorded.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** A board entry is one appended fact; tasks are folded from the entry log. */
export type TaskBoardEntry =
  | { kind: "create"; id: string; title: string; detail?: string; at: number }
  | { kind: "claim"; id: string; owner: string; at: number }
  | { kind: "complete"; id: string; owner: string; result?: string; at: number }
  | { kind: "update"; id: string; owner: string; note: string; at: number };

export type TaskStatus = "open" | "claimed" | "done";

/** A task folded from the entry log. */
export interface TaskSnapshot {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  owner?: string;
  result?: string;
  notes: string[];
  createdAt: number;
  updatedAt: number;
}

/** Outcome of a mutating board operation. */
export interface TaskBoardResult {
  ok: boolean;
  /** Human-readable reason (success detail or failure cause). */
  reason: string;
  /** The affected task's snapshot, when the operation resolved to a task. */
  task?: TaskSnapshot;
}

/** Fold an ordered entry log into current task snapshots. */
export function foldTasks(entries: TaskBoardEntry[]): Map<string, TaskSnapshot> {
  const tasks = new Map<string, TaskSnapshot>();
  for (const e of entries) {
    if (e.kind === "create") {
      // A duplicate create for an existing id is ignored (first wins).
      if (!tasks.has(e.id)) {
        tasks.set(e.id, {
          id: e.id,
          title: e.title,
          detail: e.detail,
          status: "open",
          notes: [],
          createdAt: e.at,
          updatedAt: e.at,
        });
      }
      continue;
    }
    const t = tasks.get(e.id);
    if (!t) continue; // an action on an unknown task is dropped
    if (e.kind === "claim") {
      // Only an open task may be claimed; a claim on a claimed/done task is
      // dropped by the fold (the writer already rejected it, but replaying a
      // historical log must stay consistent).
      if (t.status === "open") {
        t.status = "claimed";
        t.owner = e.owner;
        t.updatedAt = e.at;
      }
    } else if (e.kind === "complete") {
      if (t.status === "claimed" && t.owner === e.owner) {
        t.status = "done";
        t.result = e.result;
        t.updatedAt = e.at;
      }
    } else if (e.kind === "update") {
      if (t.owner === e.owner) {
        t.notes.push(e.note);
        t.updatedAt = e.at;
      }
    }
  }
  return tasks;
}

export class TaskBoard {
  private readonly file: string;
  constructor(projectStateDir: string) {
    this.file = join(projectStateDir, "taskboard.jsonl");
  }

  /** Load and fold the entry log into task snapshots, or [] if none. */
  async list(): Promise<TaskSnapshot[]> {
    const entries = await this.read();
    return [...foldTasks(entries).values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Read one task's current snapshot, or null when unknown. */
  async get(id: string): Promise<TaskSnapshot | null> {
    const entries = await this.read();
    return foldTasks(entries).get(id) ?? null;
  }

  /** Create a new open task. Returns its snapshot. */
  async create(title: string, detail?: string): Promise<TaskBoardResult> {
    const id = `task_${randomUUID().slice(0, 8)}`;
    const entry: TaskBoardEntry = { kind: "create", id, title, detail, at: Date.now() };
    const wrote = await this.append(entry);
    if (!wrote) return { ok: false, reason: "could not record the task" };
    return {
      ok: true,
      reason: `created ${id}`,
      task: {
        id,
        title,
        detail,
        status: "open",
        notes: [],
        createdAt: entry.at,
        updatedAt: entry.at,
      },
    };
  }

  /** Claim an open task for `owner`. Fails if it is already claimed/done or
   * unknown — the caller then does other work. */
  async claim(id: string, owner: string): Promise<TaskBoardResult> {
    const task = await this.get(id);
    if (!task) return { ok: false, reason: `unknown task ${id}` };
    if (task.status !== "open") {
      return {
        ok: false,
        reason:
          task.status === "claimed"
            ? `task ${id} is already claimed by ${task.owner}`
            : `task ${id} is already done`,
        task,
      };
    }
    const wrote = await this.append({ kind: "claim", id, owner, at: Date.now() });
    if (!wrote) return { ok: false, reason: "could not record the claim", task };
    return { ok: true, reason: `claimed ${id}`, task: await this.get(id) ?? task };
  }

  /** Mark a task done. Only its current owner may complete it. */
  async complete(id: string, owner: string, result?: string): Promise<TaskBoardResult> {
    const task = await this.get(id);
    if (!task) return { ok: false, reason: `unknown task ${id}` };
    if (task.status === "done") return { ok: false, reason: `task ${id} is already done`, task };
    if (task.status !== "claimed" || task.owner !== owner) {
      return { ok: false, reason: `task ${id} is not claimed by you`, task };
    }
    const wrote = await this.append({ kind: "complete", id, owner, result, at: Date.now() });
    if (!wrote) return { ok: false, reason: "could not record completion", task };
    return { ok: true, reason: `completed ${id}`, task: await this.get(id) ?? task };
  }

  /** Append a progress note to a task. Only its current owner may update it. */
  async update(id: string, owner: string, note: string): Promise<TaskBoardResult> {
    const task = await this.get(id);
    if (!task) return { ok: false, reason: `unknown task ${id}` };
    if (task.owner !== owner) {
      return { ok: false, reason: `task ${id} is not claimed by you`, task };
    }
    const wrote = await this.append({ kind: "update", id, owner, note, at: Date.now() });
    if (!wrote) return { ok: false, reason: "could not record the note", task };
    return { ok: true, reason: `updated ${id}`, task: await this.get(id) ?? task };
  }

  private async read(): Promise<TaskBoardEntry[]> {
    try {
      const raw = await readFile(this.file, "utf-8");
      const out: TaskBoardEntry[] = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (t === "") continue;
        try {
          out.push(JSON.parse(t) as TaskBoardEntry);
        } catch {
          /* skip a corrupt line, keep the rest */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async append(entry: TaskBoardEntry): Promise<boolean> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(entry) + "\n", "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}
