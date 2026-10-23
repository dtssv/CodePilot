// Helpers for stamping persisted session events with harness-style metadata
// (cwd, git branch, core version, parent chain).

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { Event, EventMeta } from "./types.js";

const require = createRequire(import.meta.url);

/** `@codepilot/core` version embedded on every persisted event. */
export const CORE_VERSION: string =
  (require("../package.json") as { version?: string }).version ?? "0.0.0";

/** Best-effort current branch; never throws. */
export function readGitBranch(cwd: string): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true,
    });
    if (r.status !== 0) return undefined;
    const branch = (r.stdout ?? "").trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable link id used for `parentId` chaining. Prefer real entity ids
 * (`message` / `tool_call`); synthesize for otherwise anonymous rows.
 */
export function linkIdForEvent(e: Event): string | undefined {
  switch (e.type) {
    case "message":
    case "tool_call":
      return e.id;
    case "tool_result":
      return `result:${e.toolCallId}`;
    case "request":
      return `request:${e.startedAt}`;
    case "compaction":
      return e.keepFrom !== undefined ? `compaction:${e.keepFrom}` : `compaction:${e.ts ?? 0}`;
    case "error":
      return `error:${e.ts ?? 0}:${e.message.slice(0, 24)}`;
    case "mode":
      return `mode:${e.mode}:${e.ts ?? 0}`;
    case "model":
      return `model:${e.model}:${e.ts ?? 0}`;
    case "subagent":
      return `subagent:${e.parentToolCallId}:${e.index}`;
    default:
      return undefined;
  }
}

export interface StampContext {
  cwd: string;
  gitBranch?: string;
  parentId?: string;
  now?: number;
  version?: string;
}

/** Attach EventMeta fields without mutating the live in-memory event. */
export function stampEventMeta(e: Event, ctx: StampContext): Event {
  const meta: EventMeta = {
    ts: e.ts ?? ctx.now ?? Date.now(),
    parentId: e.parentId ?? ctx.parentId,
    cwd: e.cwd ?? ctx.cwd,
    gitBranch: e.gitBranch ?? ctx.gitBranch,
    version: e.version ?? ctx.version ?? CORE_VERSION,
  };
  return { ...e, ...meta };
}
