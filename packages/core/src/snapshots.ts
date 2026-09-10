// File-state snapshots for checkpoint rewind.
//
// Problem: the agent edits files incrementally across a turn. If a later
// edit breaks the build, the user may want to "rewind" to a known-good
// state without manually undoing each edit. opencode tracks this with
// full-tree git snapshots; we take a lighter approach — snapshot only the
// files the agent touches, on-demand, keyed by a checkpoint id.
//
// Lifecycle:
//   - `createSnapshot(cwd, label)` — records the current content of every
//     file that has been touched so far in the session, returns an id.
//   - `recordFileTouch(cwd, path, contentBefore)` — called by edit/write
//     tools BEFORE they write, so the snapshot stores the pre-edit state.
//   - `rewindToSnapshot(cwd, id)` — restores every tracked file to its
//     state at snapshot creation time. Files created after the snapshot
//     are deleted; files deleted after are restored.
//
// Storage: `.codepilot/snapshots/<id>/manifest.json` + per-file blobs.
// Snapshots are pruned to a configurable max count (default 20) to bound
// disk usage.

import { mkdir, readFile, writeFile, readdir, rm, stat, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";

const SNAPSHOTS_DIR = ".codepilot/snapshots";
const MANIFEST_NAME = "manifest.json";
const DEFAULT_MAX_SNAPSHOTS = 20;

export interface SnapshotManifest {
  id: string;
  label: string;
  createdAt: string;
  /** Map of repo-relative path → blob filename within the snapshot dir. */
  files: Record<string, string>;
}

export interface SnapshotEntry {
  id: string;
  label: string;
  createdAt: string;
  fileCount: number;
}

function snapshotsRoot(cwd: string): string {
  return join(cwd, SNAPSHOTS_DIR);
}

function snapshotDir(cwd: string, id: string): string {
  return join(snapshotsRoot(cwd), id);
}

function manifestPath(cwd: string, id: string): string {
  return join(snapshotDir(cwd, id), MANIFEST_NAME);
}

/** List all snapshots (oldest first), with summary metadata. */
export async function listSnapshots(cwd: string): Promise<SnapshotEntry[]> {
  const root = snapshotsRoot(cwd);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: SnapshotEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const m = JSON.parse(
        await readFile(join(root, e.name, MANIFEST_NAME), "utf-8")
      ) as SnapshotManifest;
      out.push({
        id: m.id,
        label: m.label,
        createdAt: m.createdAt,
        fileCount: Object.keys(m.files).length,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Create a snapshot of the given files' current on-disk content. The
 * caller (typically the session) supplies the set of paths to snapshot —
 * usually "every file the agent has touched this session". Returns the
 * snapshot id.
 */
export async function createSnapshot(
  cwd: string,
  paths: string[],
  label: string,
  opts: { maxSnapshots?: number } = {}
): Promise<string> {
  const id = randomUUID().slice(0, 8);
  const dir = snapshotDir(cwd, id);
  await mkdir(dir, { recursive: true });
  const files: Record<string, string> = {};
  let blobIdx = 0;
  for (const p of paths) {
    const abs = resolve(cwd, p);
    let content: string;
    try {
      content = await readFile(abs, "utf-8");
    } catch (err) {
      // File does not exist (or unreadable) — record a tombstone so
      // rewind knows to delete it if it appears later.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const rel = relative(cwd, abs);
        files[rel] = "__TOMBSTONE__";
        continue;
      }
      throw err;
    }
    const blobName = `${String(blobIdx++).padStart(4, "0")}.blob`;
    await writeFile(join(dir, blobName), content, "utf-8");
    files[relative(cwd, abs)] = blobName;
  }
  const manifest: SnapshotManifest = {
    id,
    label,
    createdAt: new Date().toISOString(),
    files,
  };
  await writeFile(manifestPath(cwd, id), JSON.stringify(manifest, null, 2), "utf-8");
  await pruneSnapshots(cwd, opts.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  return id;
}

/** Restore every tracked file to its snapshot-time state. */
export async function rewindToSnapshot(cwd: string, id: string): Promise<{
  restored: string[];
  deleted: string[];
}> {
  const dir = snapshotDir(cwd, id);
  if (!existsSync(dir)) {
    throw new Error(`snapshot ${id} not found`);
  }
  const manifest = JSON.parse(
    await readFile(manifestPath(cwd, id), "utf-8")
  ) as SnapshotManifest;
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const [rel, blobName] of Object.entries(manifest.files)) {
    const abs = resolve(cwd, rel);
    if (blobName === "__TOMBSTONE__") {
      // File did not exist at snapshot time — delete it if present now.
      if (existsSync(abs)) {
        await rm(abs);
        deleted.push(rel);
      }
      continue;
    }
    const content = await readFile(join(dir, blobName), "utf-8");
    // Ensure parent dir exists.
    const parent = resolve(abs, "..");
    if (!existsSync(parent)) await mkdir(parent, { recursive: true });
    await writeFile(abs, content, "utf-8");
    restored.push(rel);
  }
  return { restored, deleted };
}

/** Delete a snapshot by id. */
export async function deleteSnapshot(cwd: string, id: string): Promise<void> {
  const dir = snapshotDir(cwd, id);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
}

/** Keep only the most recent `max` snapshots (by createdAt). */
async function pruneSnapshots(cwd: string, max: number): Promise<void> {
  const all = await listSnapshots(cwd);
  if (all.length <= max) return;
  const toRemove = all.slice(0, all.length - max);
  for (const s of toRemove) {
    await deleteSnapshot(cwd, s.id);
  }
}
