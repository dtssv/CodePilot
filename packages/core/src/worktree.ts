// Git worktree isolation for sub-agents.
//
// Creates a linked git worktree for `isolation: "worktree"` sub-agents, so
// parallel fan-outs can each mutate files without stomping each other or the
// parent tree. Shares the .git object database; edits land in the worktree's
// own working tree. We do NOT auto-merge back (the parent decides) nor sandbox
// beyond the existing policy. Fail-soft: not-a-repo / missing git / creation
// failure → returns { ok: false } and the caller falls back to the original
// cwd. Removal failures are swallowed and logged.

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
 * working tree. */
  cwd: string;
 /** Human-readable label folded into the branch name (sanitised). Helps
 * identify the worktree in `git worktree list`. */
  label?: string;
 /** Optional base ref to create the worktree from. Defaults to "HEAD" of
 * the current branch. Must be a valid git ref (branch, tag, commit). */
  baseRef?: string;
 /** Override the parent directory for the worktree. Defaults to a fresh
 * temp dir under the OS tmpdir. Useful for tests. */
  parentDir?: string;
}

export interface WorktreeHandle {
 /** Absolute path to the new worktree's working directory. The sub-agent
 * runs with this as its `cwd`. */
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
 * repo / git unavailable. */
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
 * repo's object database but has its own working tree + index. Returns a
 * handle the caller uses as the sub-agent's cwd, and later passes to
 * `removeWorktree` for cleanup. */
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

/** Re-attach to a sub-agent's prior worktree on a continue, so it resumes on
 * its own branch (with its earlier commits) instead of branching from a fresh
 * HEAD. Resolution order:
 *  1. If the recorded path still exists AND is a live worktree checked out on
 *     the recorded branch → reuse it in place.
 *  2. Else, if the branch still exists → add a fresh worktree checked out on
 *     that existing branch (so prior commits carry over).
 *  3. Else → not reusable; the caller creates a brand-new worktree.
 * Fail-soft: any git error yields { ok: false } and the caller recreates. */
export async function attachWorktree(prior: {
  path: string;
  branch: string;
  baseRef: string;
  repoRoot: string;
}): Promise<{ ok: true; worktree: WorktreeHandle; reused: boolean } | { ok: false; message: string }> {
  const repoRoot = (await resolveRepoRoot(prior.repoRoot)) ?? prior.repoRoot;
  // 1. Reuse the existing checkout if it is still a live worktree on the branch.
  if (existsSync(prior.path)) {
    try {
      const { stdout } = await execFileP(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: prior.path, timeout: GIT_TIMEOUT_MS }
      );
      if (stdout.trim() === prior.branch) {
        return {
          ok: true,
          reused: true,
          worktree: { path: prior.path, branch: prior.branch, baseRef: prior.baseRef, repoRoot },
        };
      }
    } catch {
      /* not a live worktree; fall through to re-create from the branch */
    }
  }
  // 2. Re-create a worktree checked out on the existing branch.
  const branchExists = await execFileP(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${prior.branch}`],
    { cwd: repoRoot, timeout: GIT_TIMEOUT_MS }
  )
    .then(() => true)
    .catch(() => false);
  if (!branchExists) {
    return { ok: false, message: `prior branch ${prior.branch} no longer exists` };
  }
  const parent = mkdtempSync(join(tmpdir(), "cp-worktree-"));
  const worktreePath = join(parent, prior.branch);
  try {
    // `git worktree add <path> <branch>` checks out the EXISTING branch (no -b),
    // so the sub-agent's prior commits come back.
    await execFileP(
      "git",
      ["worktree", "add", worktreePath, prior.branch],
      { cwd: repoRoot, timeout: GIT_TIMEOUT_MS }
    );
  } catch (err) {
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, message: `git worktree add (reattach) failed: ${(err as Error).message}` };
  }
  return {
    ok: true,
    reused: false,
    worktree: { path: worktreePath, branch: prior.branch, baseRef: prior.baseRef, repoRoot },
  };
}

/** Remove a worktree and delete its branch. By default this is a forced
 * removal (`--force`) so a sub-agent's uncommitted changes don't block
 * cleanup — the whole point of isolation is that we throw the experiment
 * away. Set `keepBranch: true` to retain the branch (e.g. the parent wants
 * to merge it later). */
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
 * stat. Useful for appending to the conclusion so the parent knows what
 * the sub-agent did. Returns an empty string if the tree is clean. */
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
 * whether worktree isolation is even an option. */
export async function isGitAvailable(cwd: string): Promise<boolean> {
  const root = await resolveRepoRoot(cwd);
  return root !== null;
}

/** The set of files with working-tree changes at `cwd` (staged, unstaged, or
 * untracked), as repo-root-relative paths from `git status --porcelain`. This
 * is tool-agnostic git evidence: a file changed via `bash`/`sed -i` shows up
 * here even though no write-tool call named it. Returns an empty set when `cwd`
 * is not a git repo or git fails (the caller then relies on tool-path evidence
 * alone). */
export async function gitTouchedFiles(cwd: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { stdout } = await execFileP(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd, timeout: GIT_TIMEOUT_MS }
    );
    for (const line of stdout.split("\n")) {
      // Porcelain v1: "XY <path>" (or "XY <old> -> <new>" for renames).
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.length < 4) continue;
      let path = trimmed.slice(3).trim();
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4).trim();
      // Strip surrounding quotes git adds for paths with special chars.
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
      if (path.length > 0) out.add(path);
    }
  } catch {
    /* not a git repo or git failed — tool-path evidence only */
  }
  return out;
}
