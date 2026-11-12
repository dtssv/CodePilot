// Durable per-sub-agent transcript store: an append-only JSONL file at
// `<projectStateDir>/subagents/<sessionId>.jsonl` of replayable events only.
// It makes a sub-agent CONTINUABLE — passing its sessionId back replays stored
// events as history instead of restarting. Best-effort: a missing/corrupt file
// just means the sub-agent runs fresh.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Event } from "./types.js";

/** Event kinds worth persisting for replay (same policy the session uses for
 * sub-agent inner events). Deltas / activity / retry are live-only. */
function isReplayable(e: Event): boolean {
  return (
    e.type === "message" ||
    e.type === "tool_call" ||
    e.type === "tool_result" ||
    e.type === "plan" ||
    e.type === "usage" ||
    e.type === "error"
  );
}

/** Sanitize a sub-agent id into a safe filename stem. */
function safeStem(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "subagent";
}

export class SubagentStore {
  private readonly dir: string;
  constructor(projectStateDir: string) {
    this.dir = join(projectStateDir, "subagents");
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, `${safeStem(sessionId)}.jsonl`);
  }

  /** Append one replayable event. No-op for live-only events and on error. */
  async append(sessionId: string, event: Event): Promise<void> {
    if (!isReplayable(event)) return;
    const file = this.pathFor(sessionId);
    try {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(event) + "\n", "utf-8");
    } catch {
      /* best-effort: a failed append just means this sub-agent can't resume */
    }
  }

  /** Append many events in order (used to persist an adopted attempt). */
  async appendAll(sessionId: string, events: Event[]): Promise<void> {
    const lines = events
      .filter(isReplayable)
      .map((e) => JSON.stringify(e))
      .join("\n");
    if (lines === "") return;
    const file = this.pathFor(sessionId);
    try {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, lines + "\n", "utf-8");
    } catch {
      /* best-effort */
    }
  }

  /** Replace the file with exactly these events (used when an adopted attempt
   * supersedes earlier discarded attempts). */
  async replace(sessionId: string, events: Event[]): Promise<void> {
    const file = this.pathFor(sessionId);
    const lines = events
      .filter(isReplayable)
      .map((e) => JSON.stringify(e))
      .join("\n");
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, lines === "" ? "" : lines + "\n", "utf-8");
    } catch {
      /* best-effort */
    }
  }

  /** Load a sub-agent's stored events in order, or [] if none/unreadable. */
  async load(sessionId: string): Promise<Event[]> {
    try {
      const raw = await readFile(this.pathFor(sessionId), "utf-8");
      const out: Event[] = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (t === "") continue;
        try {
          out.push(JSON.parse(t) as Event);
        } catch {
          /* skip a corrupt line, keep the rest */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Whether a sub-agent transcript exists and has at least one event. */
  async exists(sessionId: string): Promise<boolean> {
    const events = await this.load(sessionId);
    return events.length > 0;
  }

  /** Path to the small JSON sidecar holding non-event metadata (e.g. the
   * worktree a sub-agent ran in, so a continue can re-attach to it). */
  private metaPathFor(sessionId: string): string {
    return join(this.dir, `${safeStem(sessionId)}.meta.json`);
  }

  /** Persist this sub-agent's metadata (merged over any existing). Best-effort:
   * a failure just means a continue can't re-attach to the prior worktree. */
  async saveMeta(sessionId: string, meta: SubagentMeta): Promise<void> {
    const file = this.metaPathFor(sessionId);
    try {
      const prev = await this.loadMeta(sessionId);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ ...prev, ...meta }, null, 2), "utf-8");
    } catch {
      /* best-effort */
    }
  }

  /** Load this sub-agent's metadata, or {} when absent/unreadable. */
  async loadMeta(sessionId: string): Promise<SubagentMeta> {
    try {
      const raw = await readFile(this.metaPathFor(sessionId), "utf-8");
      const parsed = JSON.parse(raw) as SubagentMeta;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
}

/** Non-event metadata persisted alongside a sub-agent's transcript. */
export interface SubagentMeta {
  /** The git worktree this sub-agent ran in, so a continue can re-attach to the
   * same checkout (or re-create from the same branch) instead of branching from
   * a fresh HEAD. */
  worktree?: {
    path: string;
    branch: string;
    baseRef: string;
    repoRoot: string;
  };
}
