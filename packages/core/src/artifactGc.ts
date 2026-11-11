// Artifact garbage collection (mark-and-sweep).
//
// Artifacts (spilled tool output + offloaded images) live in a per-PROJECT,
// content-addressed store (`~/.codepilot/projects/<hash>/artifacts/`). The store
// is shared by every session in that project and dedups identical content by
// hash, so a single artifact may be referenced by several sessions. Deleting a
// session therefore must NOT blindly delete the artifacts it referenced — a
// sibling session may still point at the same hash.
//
// The correct, source-of-truth-derived answer is a mark-and-sweep:
//  1. MARK: scan every session JSONL whose cwd maps to the target project and
//     collect the full set of still-referenced artifact refs (tool_result
//     artifactRef, offloaded image `{ref}`, and content_replacement records).
//  2. SWEEP: list the artifacts physically on disk and delete only those whose
//     hash is referenced by NO session.
//
// This needs no second source of truth (no refcount index to drift): it reads
// the JSONL logs directly, so it is always correct and safe to re-run. It is
// fail-soft throughout — an unreadable session is treated as referencing
// nothing extra is wrong, so a read failure makes us CONSERVATIVE (we keep the
// artifact) rather than deleting a maybe-referenced one.

import { readFile, readdir } from "node:fs/promises";
import { ArtifactStore } from "./tools/artifacts.js";
import { projectStatePath, projectHash } from "./projectState.js";
import { SESSIONS_DIR, sessionPath, loadCwdFromDisk } from "./session-utils.js";
import type { Event } from "./types.js";

/** Collect every artifact ref (normalised to "art_<hash>") referenced anywhere
 * in a single session's JSONL. Fail-soft: a missing/unreadable file or a
 * malformed line contributes nothing. */
export async function collectSessionArtifactRefs(
  id: string,
): Promise<Set<string>> {
  const refs = new Set<string>();
  let text: string;
  try {
    text = await readFile(sessionPath(id), "utf-8");
  } catch {
    return refs;
  }
  const add = (ref: unknown): void => {
    if (typeof ref !== "string") return;
    const hash = ArtifactStore.hashOf(ref);
    if (hash) refs.add(`art_${hash}`);
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      continue; // malformed line — skip
    }
    if (e.type === "tool_result" && e.artifactRef) add(e.artifactRef);
    if (e.type === "content_replacement") add(e.artifactRef);
    // Offloaded images carry `{ mediaType, ref }` in an `images[]` array on
    // message / tool_result events.
    const imgs = (e as { images?: Array<{ ref?: string }> }).images;
    if (Array.isArray(imgs)) for (const img of imgs) add(img.ref);
  }
  return refs;
}

/** Session ids whose recorded cwd maps to the SAME project hash as `cwd`.
 * Sessions are stored flat with a `.cwd` sidecar; we match by project hash so
 * every session that shares the project's artifact store is included. A session
 * without a cwd sidecar is conservatively included (it may belong to the
 * project and we must not delete artifacts it might reference). */
export async function sessionIdsInProject(cwd: string): Promise<string[]> {
  const target = projectHash(cwd);
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const ids = entries
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => n.slice(0, -6));
  const out: string[] = [];
  for (const id of ids) {
    const sessionCwd = await loadCwdFromDisk(id);
    // No cwd recorded → include conservatively (keep its artifacts referenced).
    if (!sessionCwd || projectHash(sessionCwd) === target) out.push(id);
  }
  return out;
}

export interface ArtifactGcResult {
  /** Artifact refs deleted. */
  removed: string[];
  /** Total bytes reclaimed. */
  bytesReclaimed: number;
  /** Artifacts scanned on disk. */
  scanned: number;
  /** Distinct refs still referenced by a live session. */
  referenced: number;
}

/**
 * Mark-and-sweep the artifact store for the project containing `cwd`. Deletes
 * only artifacts referenced by no session in that project. Safe to re-run and
 * fail-soft: any per-session read error makes the sweep conservative (keeps the
 * artifact). `dryRun` reports what WOULD be removed without deleting.
 */
export async function gcProjectArtifacts(
  cwd: string,
  opts: { dryRun?: boolean } = {},
): Promise<ArtifactGcResult> {
  const store = new ArtifactStore(projectStatePath(cwd, "artifacts"));
  const onDisk = await store.list();
  if (onDisk.length === 0) {
    return { removed: [], bytesReclaimed: 0, scanned: 0, referenced: 0 };
  }
  // MARK: union of refs across every session in the project.
  const referenced = new Set<string>();
  for (const id of await sessionIdsInProject(cwd)) {
    for (const ref of await collectSessionArtifactRefs(id)) referenced.add(ref);
  }
  // SWEEP: delete the on-disk artifacts nobody references.
  const removed: string[] = [];
  let bytesReclaimed = 0;
  for (const ref of onDisk) {
    if (referenced.has(ref)) continue;
    if (opts.dryRun) {
      const bytes = (await store.size(ref)) ?? 0;
      bytesReclaimed += bytes;
      removed.push(ref);
      continue;
    }
    bytesReclaimed += await store.remove(ref);
    removed.push(ref);
  }
  return {
    removed,
    bytesReclaimed,
    scanned: onDisk.length,
    referenced: referenced.size,
  };
}
