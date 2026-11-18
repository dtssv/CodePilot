// File-state snapshots for checkpoint rewind.
//
// `createSnapshot` stores on-disk content of every touched file (at a checkpoint
// boundary, pre-edit). `rewindToSnapshot` restores them; files created after are
// deleted, deleted ones restored. Under `~/.codepilot/projects/<hash>/snapshots/`.

import { mkdir, readFile, writeFile, readdir, rm, stat, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { projectStatePath } from "../workspace/projectState.js";

const MANIFEST_NAME = "manifest.json";
/** Two snapshots per file-changing turn, shared by every session of the project. */
const DEFAULT_MAX_SNAPSHOTS = 400;
const TOMBSTONE = "__TOMBSTONE__";

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
  return projectStatePath(cwd, "snapshots");
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
 * Create a snapshot of the given files' current on-disk content (typically
 * every file the agent has touched this session) and return the snapshot id.
 */
export async function createSnapshot(
  cwd: string,
  paths: string[],
  label: string,
  opts: { maxSnapshots?: number } = {}
): Promise<string> {
  const contents = new Map<string, Buffer | null>();
  for (const p of paths) {
    const abs = resolve(cwd, p);
    contents.set(abs, await readFileOrNull(abs));
  }
  return createSnapshotFromContents(cwd, contents, label, opts);
}

/** Current bytes of `abs`, or null when it does not exist. */
export async function readFileOrNull(abs: string): Promise<Buffer | null> {
  try {
    return await readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Create a snapshot from already-captured contents (path → bytes, or null for
 * "did not exist", which rewind turns into a delete). Used for pre-images taken
 * just before a tool overwrote the file.
 */
export async function createSnapshotFromContents(
  cwd: string,
  contents: Map<string, Buffer | null>,
  label: string,
  opts: { maxSnapshots?: number } = {}
): Promise<string> {
  const id = randomUUID().slice(0, 8);
  const dir = snapshotDir(cwd, id);
  await mkdir(dir, { recursive: true });
  const files: Record<string, string> = {};
  let blobIdx = 0;
  for (const [p, content] of contents) {
    const rel = relative(cwd, resolve(cwd, p));
    if (content === null) {
      files[rel] = TOMBSTONE;
      continue;
    }
    const blobName = `${String(blobIdx++).padStart(4, "0")}.blob`;
    await writeFile(join(dir, blobName), content);
    files[rel] = blobName;
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
    if (blobName === TOMBSTONE) {
 // File did not exist at snapshot time — delete it if present now.
      if (existsSync(abs)) {
        await rm(abs);
        deleted.push(rel);
      }
      continue;
    }
    const content = await readFile(join(dir, blobName));
 // Ensure parent dir exists.
    const parent = resolve(abs, "..");
    if (!existsSync(parent)) await mkdir(parent, { recursive: true });
    await writeFile(abs, content);
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
