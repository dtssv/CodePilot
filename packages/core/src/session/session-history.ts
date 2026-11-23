import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { liveTranscript, visibleHistory } from "../compaction/compaction.js";
import type { CodepilotConfig, Event } from "../types.js";
import { WorkspaceTracker, type TreeChange } from "../workspace/workspaceTracker.js";
import { projectStatePath } from "../workspace/projectState.js";
import {
  createSnapshot,
  listSnapshots,
  rewindToSnapshot,
} from "./snapshots.js";
import { TASK_BOUNDARY_MARKER } from "./session-helpers.js";

export type UndoEntry = {
  baselineId: string;
  afterId: string;
  label: string;
  baseTree?: string;
  afterTree?: string;
};

export type HistoryHost = {
  cwd: string;
  id: string;
  config: CodepilotConfig;
  readOnly: boolean;
  touchedFiles: Set<string>;
  events: Event[];
  persisted: Event[];
  undoStack: Array<UndoEntry>;
  redoStack: Array<UndoEntry>;
  workspaceTracker: WorkspaceTracker | null | undefined;
  lastProviderInputTokens: number;
  contextAnchor: { input: number; eventCount: number } | null;
  foldedToolResultStubs: Map<string, string>;
  persistEvent(e: Event): Promise<void>;
  notify(e: Event): void;
  isBusy(): boolean;
};

/**
 * Snapshot the current on-disk state of every file the agent has touched
 * this session. Returns a snapshot id that can be passed to `rewind`.
 * Call this at a "known-good" boundary (e.g. after tests pass) so the
 * user can later undo a broken sequence of edits.
 */
export async function sessionSnapshot(host: HistoryHost, label: string): Promise<string> {
  const paths = [...host.touchedFiles];
  if (paths.length === 0) {
    // Nothing touched yet — still record a snapshot so rewind can detect
    // files created after this point.
  }
  return createSnapshot(host.cwd, paths, label);
}

/** Rewind every touched file to its state at snapshot `id`. */
export async function sessionRewind(
  host: HistoryHost,
  id: string,
): Promise<{ restored: string[]; deleted: string[] }> {
  return rewindToSnapshot(host.cwd, id);
}

/** List available snapshots (oldest first). */
export async function sessionListSnapshots(
  host: HistoryHost,
): Promise<{ id: string; label: string; createdAt: string; fileCount: number }[]> {
  return listSnapshots(host.cwd);
}

/** Append (and persist) an `undo_boundary` control event so the undo/redo
 * stacks can be rebuilt after a reload. Not notified to subscribers and not a
 * model-visible event. */
export async function persistUndoBoundary(
  host: HistoryHost,
  action: "push" | "undo" | "redo",
  entry: UndoEntry,
): Promise<void> {
  const ev: Event = { type: "undo_boundary", action, ...entry };
  host.events.push(ev);
  await host.persistEvent(ev).catch(() => undefined);
}

/** Undo the last agent turn's file edits. */
export async function sessionUndo(
  host: HistoryHost,
): Promise<{ restored: string[]; deleted: string[]; label: string }> {
  const entry = host.undoStack.pop();
  if (!entry) throw new Error("Nothing to undo.");
  const { shellReverted, ...result } = await revertUndoEntry(host, entry);
  // The filesystem is reverted but the transcript still claims those writes
  // happened. Append a model-visible notice so the next turn sees the real
  // state. Append-only (no truncation) keeps the event-sourced log intact.
  const changed = [...new Set([...result.restored, ...result.deleted])].sort();
  const fileList = changed.length > 0 ? changed.join(", ") : "(no tracked files)";
  const notice: Event = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "user",
    content: [
      {
        type: "text",
        text:
          `<undo_notice>\n` +
          `The previous turn's file edits were reverted by the user (/undo: ${entry.label}). ` +
          `The working tree is back to its pre-turn state. Affected paths: ${fileList}. ` +
          `Any earlier tool_result in this conversation that reported writing or editing ` +
          `these files is now STALE — the changes no longer exist on disk. Re-read any file ` +
          `before assuming its contents. ` +
          (shellReverted
            ? `Workspace file changes made by shell/MCP commands in that turn were reverted too; ` +
              `side effects outside the workspace files (git pushes, API calls, installed ` +
              `packages, gitignored outputs) are NOT undone.\n`
            : `Note: only tracked workspace files are restored — side effects of shell/MCP/network ` +
              `operations (commands run, git pushes, API calls, deletes outside the tracked set) ` +
              `are NOT undone.\n`) +
          `</undo_notice>`,
      },
    ],
  };
  host.events.push(notice);
  await host.persistEvent(notice).catch(() => undefined);
  host.notify(notice);
  return { ...result, label: entry.label };
}

/** Revert one undo entry's files (per-file snapshot + workspace tree), move
 * it to the redo stack and persist the boundary. No transcript notice. */
export async function revertUndoEntry(
  host: HistoryHost,
  entry: UndoEntry,
): Promise<{ restored: string[]; deleted: string[]; shellReverted: boolean }> {
  const result = await rewindToSnapshot(host.cwd, entry.baselineId);
  // Delete files created during the turn (present in after, absent/tombstone in baseline).
  try {
    const afterPath = pathResolve(
      projectStatePath(host.cwd, "snapshots"),
      entry.afterId,
      "manifest.json",
    );
    const beforePath = pathResolve(
      projectStatePath(host.cwd, "snapshots"),
      entry.baselineId,
      "manifest.json",
    );
    if (existsSync(afterPath) && existsSync(beforePath)) {
      const after = JSON.parse(await readFile(afterPath, "utf-8")) as {
        files: Record<string, string>;
      };
      const before = JSON.parse(await readFile(beforePath, "utf-8")) as {
        files: Record<string, string>;
      };
      const { rm } = await import("node:fs/promises");
      for (const rel of Object.keys(after.files)) {
        const prev = before.files[rel];
        if (!prev || prev === "__TOMBSTONE__") {
          const abs = pathResolve(host.cwd, rel);
          if (existsSync(abs)) {
            await rm(abs, { force: true });
            if (!result.deleted.includes(rel)) result.deleted.push(rel);
          }
        }
      }
    }
  } catch {
    /* best-effort */
  }
  const shellReverted = await applyTreeSnapshot(host, entry, "undo", result);
  host.redoStack.push(entry);
  await persistUndoBoundary(host, "undo", entry);
  return { ...result, shellReverted };
}

/** User prompts `/rewind` can go back to (oldest first). Sessions written
 * before `turnStart` existed fall back to "any user message that is not an
 * undo/redo notice or task boundary". */
export function rewindTargets(
  host: HistoryHost,
): Array<{ messageId: string; text: string; ts?: number }> {
  const history = visibleHistory(host.persisted);
  const hasMarks = history.some((e) => e.type === "message" && e.turnStart);
  const out: Array<{ messageId: string; text: string; ts?: number }> = [];
  for (const e of history) {
    if (e.type !== "message" || e.role !== "user") continue;
    const text = e.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const isPrompt = hasMarks
      ? e.turnStart === true
      : !text.startsWith("<undo_notice>") &&
        !text.startsWith("<redo_notice>") &&
        !text.startsWith(TASK_BOUNDARY_MARKER);
    if (isPrompt) out.push({ messageId: e.id, text, ts: e.ts });
  }
  return out;
}

/**
 * Rewind the conversation to just before user prompt `toMessageId` (default:
 * the latest prompt): that prompt and everything after it leave both the
 * model view and the displayed history, and — unless `files: false` — the
 * file changes of those turns are reverted through the undo stack. The log
 * stays append-only: a `rewind` event marks the hidden span. Returns the
 * prompt text so a client can put it back in the input box.
 */
export async function rewindConversation(
  host: HistoryHost,
  toMessageId?: string,
  opts: { files?: boolean } = {},
): Promise<{ messageId: string; text: string; turns: number; restored: string[]; deleted: string[] }> {
  if (host.isBusy()) throw new Error("Cannot rewind while a turn is running.");
  const targets = rewindTargets(host);
  const pos = toMessageId ? targets.findIndex((t) => t.messageId === toMessageId) : targets.length - 1;
  if (pos < 0) throw new Error(toMessageId ? `No prompt ${toMessageId} to rewind to.` : "Nothing to rewind.");
  const target = targets[pos]!;
  const from = host.persisted.findIndex((e) => e.type === "message" && e.id === target.messageId);

  const restored = new Set<string>();
  const deleted = new Set<string>();
  if (opts.files !== false) {
    const pushedAt = (u: UndoEntry): number => {
      for (let i = host.persisted.length - 1; i >= 0; i--) {
        const e = host.persisted[i]!;
        if (e.type === "undo_boundary" && e.action === "push" && e.baselineId === u.baselineId) return i;
      }
      return -1;
    };
    while (host.undoStack.length > 0 && pushedAt(host.undoStack[host.undoStack.length - 1]!) > from) {
      const r = await revertUndoEntry(host, host.undoStack.pop()!);
      r.restored.forEach((p) => restored.add(p));
      r.deleted.forEach((p) => deleted.add(p));
    }
  }

  const marker: Event = { type: "rewind", toMessageId: target.messageId };
  await host.persistEvent(marker);
  host.events = liveTranscript(host.persisted);
  host.lastProviderInputTokens = 0;
  host.contextAnchor = null;
  host.foldedToolResultStubs.clear();
  host.notify(marker);
  return {
    messageId: target.messageId,
    text: target.text,
    turns: targets.length - pos,
    restored: [...restored].filter((p) => !deleted.has(p)).sort(),
    deleted: [...deleted].sort(),
  };
}

/** Re-apply the last undone turn's file edits (`/redo`). */
export async function sessionRedo(
  host: HistoryHost,
): Promise<{ restored: string[]; deleted: string[]; label: string }> {
  const entry = host.redoStack.pop();
  if (!entry) throw new Error("Nothing to redo.");
  const result = await rewindToSnapshot(host.cwd, entry.afterId);
  const shellReapplied = await applyTreeSnapshot(host, entry, "redo", result);
  host.undoStack.push(entry);
  await persistUndoBoundary(host, "redo", entry);
  // Symmetric to undo: the edits are back on disk, so a prior undo_notice in
  // the transcript (which told the model the changes were gone) is now itself
  // stale. Append a reconciling notice so the next turn sees current state.
  const changed = [...new Set([...result.restored, ...result.deleted])].sort();
  const fileList = changed.length > 0 ? changed.join(", ") : "(no tracked files)";
  const notice: Event = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "user",
    content: [
      {
        type: "text",
        text:
          `<redo_notice>\n` +
          `The previously undone turn's file edits were re-applied by the user (/redo: ${entry.label}). ` +
          `Those changes are back on disk. Affected paths: ${fileList}. If an earlier undo_notice ` +
          `said these files were reverted, that is no longer true. Re-read any file before ` +
          `assuming its contents. ` +
          (shellReapplied
            ? `Workspace file changes made by shell/MCP commands in that turn are back too; ` +
              `side effects outside the workspace files are not replayed.\n`
            : `Note: only tracked workspace files are re-applied — side effects of ` +
              `shell/MCP/network operations are not replayed.\n`) +
          `</redo_notice>`,
      },
    ],
  };
  host.events.push(notice);
  await host.persistEvent(notice).catch(() => undefined);
  host.notify(notice);
  return { ...result, label: entry.label };
}

/** Lazily open the shadow-git workspace tracker (null outside git repos or
 * when `undoTracksShell` is off). */
export async function openWorkspaceTracker(host: HistoryHost): Promise<WorkspaceTracker | null> {
  if (host.workspaceTracker === undefined) {
    host.workspaceTracker =
      host.config.undoTracksShell === false || host.readOnly
        ? null
        : await WorkspaceTracker.open(host.cwd, host.id).catch(() => null);
  }
  return host.workspaceTracker?.enabled ? host.workspaceTracker : null;
}

/** Revert (undo) or re-apply (redo) the whole-workspace delta of `entry`,
 * merging touched paths into `result`. Returns whether it applied; false
 * (fall back to per-file snapshots only) when the entry has no trees or the
 * shadow objects are gone. */
export async function applyTreeSnapshot(
  host: HistoryHost,
  entry: UndoEntry,
  direction: "undo" | "redo",
  result: { restored: string[]; deleted: string[] },
): Promise<boolean> {
  if (!entry.baseTree || !entry.afterTree) return false;
  const tracker = await openWorkspaceTracker(host);
  if (!tracker) return false;
  const [from, target] =
    direction === "undo" ? [entry.afterTree, entry.baseTree] : [entry.baseTree, entry.afterTree];
  let changes: TreeChange[];
  try {
    changes = await tracker.changes(from, target);
    await tracker.restore(target, changes);
  } catch {
    return false;
  }
  for (const c of changes) {
    const list = c.inTarget ? result.restored : result.deleted;
    if (!list.includes(c.path)) list.push(c.path);
  }
  return true;
}