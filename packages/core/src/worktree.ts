// Git worktree isolation for sub-agents (claude-code 2026-05 style).
//
// When a sub-agent runs with `isolation: "worktree"`, we create a *linked*
// git worktree from the current branch/HEAD. The sub-agent then operates on
// its own checkout — a full filesystem copy of the repo at the same commit,
// sharing the same .git object database. Edits land in the worktree's
// working tree (and index), completely isolated from the parent's tree.
//
// Benefits (mirrors claude-code's rationale):
//   - Parallel `tasks: [...]` fan-outs can each mutate files without
//     stomping on each other or on the parent's working tree.
//   - A sub-agent experiment that goes wrong is `git worktree remove`'d
//     with one call — no cleanup of half-edited files in the real tree.
//   - The parent can later `git diff`/merge the worktree's branch if the
//     sub-agent produced something worth keeping.
//
// Non-goals:
//   - We do NOT auto-merge or cherry-pick the worktree's changes back.
//     claude-code leaves that to the user/parent. We surface the worktree
//     path + branch name in the conclusion so the parent can decide.
//   - We do NOT sandbox the sub-agent's bash calls beyond the existing
//     sandbox policy — worktree isolation is about filesystem separation,
//     not process confinement.
//
// Failure modes (all fail-soft):
//   - cwd is not a git repo → returns { ok: false, reason: "not-a-repo" }.
//     The caller falls back to running the sub-agent in the original cwd.
//   - `git` is not on PATH → same "not-a-repo"-style failure.
//   - worktree creation fails (disk full, permissions, dirty index that
//     blocks checkout) → returns the error; caller falls back.
//   - removal failures are swallowed and logged — never fatal.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;

export interface WorktreeCreateOptions {
  /** The repo root / cwd to create the worktree from. Must be inside a git
   *  working tree. */
  cwd: string;
  /** Human-readable label folded into the branch name (sanitised). Helps
   *  identify the worktree in `git worktree list`. */
  label?: string;
  /** Optional base ref to create the worktree from. Defaults to "HEAD" of
   *  the current branch. Must be a valid git ref (branch, tag, commit). */
  baseRef?: string;
  /** Override the parent directory for the worktree. Defaults to a fresh
   *  temp dir under the OS tmpdir. Useful for tests. */
  parentDir?: string;
}

export interface WorktreeHandle {
  /** Absolute path to the new worktree's working directory. The sub-agent
   *  runs with this as its `cwd`. */
  path: string;
  /** The branch name created for this worktree (`cp-subagent-<id>`). */
  branch: string;
  /** The base ref the worktree was created from. */
  baseRef: string;
  /** The original repo root (for diffing / merging back later). */
  repoRoot: string;
}

export type WorktreeCreateResult =
  | { ok: true; worktree: WorktreeHandle }
  | { ok: false; reason: "not-a-repo"; message: string }
  | { ok: false; reason: "create-failed"; message: string };

export type WorktreeRemoveResult =
  | { ok: true }
  | { ok: false; message: string };

/** Resolve the absolute repo root for `cwd`, or return null if not a git
 *  repo / git unavailable. */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: GIT_TIMEOUT_MS }
    );
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** Create a linked git worktree on a fresh branch. The worktree shares the
 *  repo's object database but has its own working tree + index. Returns a
 *  handle the caller uses as the sub-agent's cwd, and later passes to
 *  `removeWorktree` for cleanup. */
export async function createWorktree(
  opts: WorktreeCreateOptions
): Promise<WorktreeCreateResult> {
  const repoRoot = await resolveRepoRoot(opts.cwd);
  if (!repoRoot) {
    return {
      ok: false,
      reason: "not-a-repo",
      message: `cwd is not inside a git working tree (or git is unavailable): ${opts.cwd}`,
    };
  }
  const baseRef = opts.baseRef ?? "HEAD";
  // Sanitise the label: lowercase alnum + dashes only, capped at 20 chars.
  const safeLabel = (opts.label ?? "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20) || "subagent";
  const id = randomUUID().slice(0, 8);
  const branch = `cp-${safeLabel}-${id}`;
  // Worktree path: a temp dir we create, then `git worktree add` into a
  // subdirectory. Using a fresh temp parent avoids collisions and keeps
  // worktrees out of the user's repo tree.
  const parent = opts.parentDir
    ? (isAbsolute(opts.parentDir) ? opts.parentDir : resolve(opts.cwd, opts.parentDir))
    : mkdtempSync(join(tmpdir(), "cp-worktree-"));
  const worktreePath = join(parent, branch);
  try {
    // `git worktree add -b <new-branch> <path> <base-ref>` creates the
    // branch and checks it out in the new worktree in one shot.
    await execFileP(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, baseRef],
      { cwd: repoRoot, timeout: GIT_TIMEOUT_MS }
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Clean up the empty temp parent we created (best-effort).
    if (!opts.parentDir) {
      try { rmSync(parent, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return {
      ok: false,
      reason: "create-failed",
      message: `git worktree add failed: ${msg}`,
    };
  }
  return {
    ok: true,
    worktree: {
      path: worktreePath,
      branch,
      baseRef,
      repoRoot,
    },
  };
}

/** Remove a worktree and delete its branch. By default this is a forced
 *  removal (`--force`) so a sub-agent's uncommitted changes don't block
 *  cleanup — the whole point of isolation is that we throw the experiment
 *  away. Set `keepBranch: true` to retain the branch (e.g. the parent wants
 *  to merge it later). */
export async function removeWorktree(
  handle: WorktreeHandle,
  opts: { keepBranch?: boolean } = {}
): Promise<WorktreeRemoveResult> {
  // `git worktree remove --force <path>` removes the working tree.
  try {
    await execFileP(
      "git",
      ["worktree", "remove", "--force", handle.path],
      { cwd: handle.repoRoot, timeout: GIT_TIMEOUT_MS }
    );
  } catch (err) {
    // Fall back to a plain filesystem removal if git refuses (e.g. the
    // worktree was already moved/deleted out of band).
    if (existsSync(handle.path)) {
      try { rmSync(handle.path, { recursive: true, force: true }); }
      catch { /* fall through to branch cleanup */ }
    }
    // Don't return early — still try to delete the branch.
    void err;
  }
  if (!opts.keepBranch) {
    try {
      await execFileP(
        "git",
        ["branch", "-D", handle.branch],
        { cwd: handle.repoRoot, timeout: GIT_TIMEOUT_MS }
      );
    } catch {
      /* branch may already be gone, or be checked out elsewhere — non-fatal */
    }
  }
  // Prune the worktree metadata so `git worktree list` stays clean.
  try {
    await execFileP(
      "git",
      ["worktree", "prune"],
      { cwd: handle.repoRoot, timeout: GIT_TIMEOUT_MS }
    );
  } catch {
    /* non-fatal */
  }
  // Best-effort: remove the temp parent dir if it's now empty.
  try {
    const parent = join(handle.path, "..");
    // rmSync with recursive:false + force only removes if empty.
    rmSync(parent, { recursive: false, force: true });
  } catch {
    /* not empty or already gone — fine */
  }
  return { ok: true };
}

/** Summarise the changes a sub-agent made in a worktree, as a unified diff
 *  stat. Useful for appending to the conclusion so the parent knows what
 *  the sub-agent did. Returns an empty string if the tree is clean. */
export async function worktreeDiffStat(handle: WorktreeHandle): Promise<string> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["diff", "--stat", "HEAD"],
      { cwd: handle.path, timeout: GIT_TIMEOUT_MS }
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

/** True if `git` is invocable from `cwd`. Used by the task tool to decide
 *  whether worktree isolation is even an option. */
export async function isGitAvailable(cwd: string): Promise<boolean> {
  const root = await resolveRepoRoot(cwd);
  return root !== null;
}
