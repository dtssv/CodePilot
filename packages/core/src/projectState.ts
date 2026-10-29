// Per-project runtime state under `~/.codepilot/projects/<hash>/`.
//
// The workspace only holds shareable config (`.codepilot/config.json`,
// agents, skills, commands) and optional human-authored `CODEPILOT.md` /
// `AGENTS.md`. Agent-written project memory is `MEMORY.md` here. Session
// transcripts stay in `~/.codepilot/sessions/`; caches, checkpoints,
// uploads, jobs, plans, and agent scratch live here so agent runs do not
// pollute the git working tree.
//
// Hash matches auto-memory (`projectHash`) so one project identity covers
// both memory and runtime state.

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { projectHash } from "./autoMemory.js";

export { projectHash };

/** Root for all per-project runtime state: `~/.codepilot/projects/<hash>/`. */
export function projectStateRoot(cwd: string): string {
  return join(homedir(), ".codepilot", "projects", projectHash(cwd));
}

/** Join a path under the project state root. */
export function projectStatePath(cwd: string, ...parts: string[]): string {
  return join(projectStateRoot(cwd), ...parts);
}

/**
 * Per-session scratch directory for temp scripts, screenshots, zips, etc.
 * Prefer this over `cwd/.tmp` or dumping files into the workspace.
 */
export function scratchDir(cwd: string, sessionId?: string): string {
  if (sessionId && sessionId.length > 0) {
    return projectStatePath(cwd, "scratch", sanitizeSessionId(sessionId));
  }
  return projectStatePath(cwd, "scratch");
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "session";
}

/**
 * Ensure the project state root exists and record the absolute cwd for
 * reverse lookup / debugging. Safe to call repeatedly.
 */
export async function ensureProjectState(
  cwd: string,
  opts?: { sessionId?: string }
): Promise<{ root: string; scratch: string }> {
  const root = projectStateRoot(cwd);
  const scratch = scratchDir(cwd, opts?.sessionId);
  await mkdir(root, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const marker = join(root, "cwd");
  try {
    const existing = await readFile(marker, "utf-8");
    if (existing.trim() !== resolve(cwd)) {
      await writeFile(marker, resolve(cwd) + "\n", "utf-8");
    }
  } catch {
    await writeFile(marker, resolve(cwd) + "\n", "utf-8");
  }
  return { root, scratch };
}

/** Short fingerprint of a path (for tests / diagnostics). */
export function pathFingerprint(p: string): string {
  return createHash("sha1").update(resolve(p)).digest("hex").slice(0, 8);
}
