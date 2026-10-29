// Durable per-sub-agent transcript store.
//
// Each sub-agent run gets its own append-only JSONL file at
// `<projectStateDir>/subagents/<sessionId>.jsonl`, mirroring the session-level
// event-sourcing model (one file per session, single writer, append+replay).
// This is what makes a sub-agent CONTINUABLE: the parent can pass the
// sub-agent's `sessionId` back as `continue_session_id` and the runner replays
// the stored events as history so the sub-agent resumes its own conversation
// instead of starting over. It also lets an interrupted in-flight sub-agent be
// picked up again — its partial transcript survives the crash.
//
// Only "replayable" events (message / tool_call / tool_result / plan / usage /
// error) are stored; live-only noise (deltas, activity) is dropped so the file
// stays a faithful, replayable transcript and does not balloon. Everything is
// best-effort: a missing/corrupt file just means the sub-agent can't be
// continued and runs fresh.

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
}
