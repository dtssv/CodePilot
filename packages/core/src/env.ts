// Environment provider — collects host, shell, git, and time information for
// the dynamic suffix of the system prompt. Tests pass a custom provider to
// avoid real `git` calls and make the suffix deterministic.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname, release, userInfo } from "node:os";

const execFileP = promisify(execFile);

export interface GitStatus {
 /** True if the cwd is inside a git working tree. */
  inRepo: boolean;
 /** Repo root (absolute). */
  root?: string;
 /** Current branch (or "HEAD" if detached). */
  branch?: string;
 /** Most recent commit subject (short). */
  lastCommit?: string;
 /** Most recent commit SHA (short). */
  lastCommitSha?: string;
}

export interface EnvironmentSnapshot {
 /** OS / kernel / arch tuple (e.g. "darwin 23.4.0 arm64"). */
  os: string;
 /** Lowercase platform name (process.platform: "darwin" | "linux" | "win32"). */
  platform: string;
 /** CPU architecture (process.arch: "arm64" | "x64" | ...). */
  arch: string;
 /** OS release / kernel version. */
  release: string;
 /** Hostname of the machine. */
  hostname: string;
 /** Current user (POSIX whoami). */
  user: string;
 /** Default shell executable (e.g. /bin/zsh). */
  shell: string;
 /** Node.js runtime version (e.g. "v20.10.0"). */
  node: string;
 /** Current working directory (absolute). */
  cwd: string;
 /** The workspace root: the git toplevel when in a repo, otherwise the cwd.
 * Surfaced so the model knows the project boundary without inferring it. */
  workspaceRoot?: string;
 /** ISO-8601 timestamp of the snapshot. */
  now: string;
 /** IANA timezone identifier (e.g. "Asia/Shanghai"). */
  timezone: string;
 /** Git status for the cwd (undefined when not a git work tree). */
  git?: GitStatus;
 /** The host surface the agent is running in: "cli" | "tui" | "vscode" | "idea".
 * Lets the prompt tailor advice (e.g. "open the diff in the editor" only
 * makes sense in an IDE). Optional — set by the host. */
  hostSurface?: "cli" | "tui" | "vscode" | "idea";
}

export interface EnvironmentProvider {
 /** Build a snapshot. Should be cheap and side-effect free (read-only FS / git). */
  snapshot(cwd: string): Promise<EnvironmentSnapshot>;
}

/**
 * Default provider: queries `process` and shells out to `git` with a tight
 * timeout. Never throws — git failures degrade gracefully to "not a repo".
 */
export const defaultEnvironmentProvider: EnvironmentProvider = {
  async snapshot(cwd: string): Promise<EnvironmentSnapshot> {
    const git = await safeGitStatus(cwd);
    return {
      os: `${process.platform} ${release()} ${process.arch}`,
      platform: process.platform,
      arch: process.arch,
      release: release(),
      hostname: hostname(),
      user: userInfo().username || "unknown",
      shell: shellSafe(),
      node: process.version,
      cwd,
      workspaceRoot: git?.root ?? cwd,
      now: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      git,
    };
  },
};

async function safeGitStatus(cwd: string): Promise<GitStatus | undefined> {
  try {
    const { stdout: toplevel } = await execFileP(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 2000 }
    );
    const root = toplevel.trim();
    if (!root) return { inRepo: false };
    let branch = "HEAD";
    let lastCommit: string | undefined;
    let lastCommitSha: string | undefined;
    try {
      const { stdout } = await execFileP(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 2000 }
      );
      branch = stdout.trim() || "HEAD";
    } catch {
 /* detached HEAD */
    }
    // Intentionally skip `git status`: dirty paths are not injected into the
    // system prompt, so a per-turn status walk is wasted work and used to nudge
    // models into re-running git for no reason.
    try {
      const { stdout } = await execFileP(
        "git",
        ["log", "-1", "--pretty=%s"],
        { cwd, timeout: 2000 }
      );
      lastCommit = stdout.trim() || undefined;
    } catch {
 /* no log */
    }
    try {
      const { stdout } = await execFileP(
        "git",
        ["log", "-1", "--pretty=%h"],
        { cwd, timeout: 2000 }
      );
      lastCommitSha = stdout.trim() || undefined;
    } catch {
 /* no sha */
    }
    return {
      inRepo: true,
      root,
      branch,
      lastCommit,
      lastCommitSha,
    };
  } catch {
    return { inRepo: false };
  }
}

function shellSafe(): string {
  const sh = process.env.SHELL;
  if (sh && sh.length > 0) return sh;
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  return "/bin/sh";
}
