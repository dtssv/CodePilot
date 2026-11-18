import type { ClientRpcHost } from "./clientTypes.js";

export async function listWorkspace(
  host: ClientRpcHost,
  path = ".",
  cwd?: string,
): Promise<{ path: string; entries: Array<{ name: string; path: string; kind: "file" | "directory"; size?: number }> }> {
  return host.call("workspace/list", { path, cwd });
}

/** Native folder dialog on the serve host (may return null if cancelled). */
export async function pickFolder(
  host: ClientRpcHost,
): Promise<{ path: string | null; supported: boolean }> {
  return host.call("workspace/pickFolder", {});
}

/** Browse absolute directories on the serve host (folder picker UI). */
export async function browseWorkspace(
  host: ClientRpcHost,
  path?: string,
): Promise<{
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string; kind: "file" | "directory" }>;
  roots: Array<{ label: string; path: string }>;
}> {
  return host.call("workspace/browse", { path });
}

export async function workspaceStat(
  host: ClientRpcHost,
  path: string,
  cwd?: string,
): Promise<{ path: string; exists: boolean; size: number; hash: string; modifiedAt?: number }> {
  return host.call("workspace/stat", { path, cwd });
}

/** List slash commands for the `/` menu (shared built-ins + md commands).
 * `kind` tells local actions ("local") apart from prompt-expanding markdown
 * commands ("prompt") without a hard-coded name list. */
export async function commandsList(
  host: ClientRpcHost,
  cwd?: string,
): Promise<{
  commands: Array<{
    name: string;
    description: string;
    argumentHint?: string;
    source: "builtin" | "project" | "user" | "plugin";
    kind: "local" | "prompt";
  }>;
  warnings: string[];
}> {
  return host.call("commands/list", { cwd });
}

/** `@`-mention completion candidates (file/dir/mcp/git/skill). */
export async function workspaceComplete(
  host: ClientRpcHost,
  query: string,
  opts: { kinds?: Array<"file" | "dir" | "mcp" | "git" | "skill">; maxResults?: number; cwd?: string } = {},
): Promise<{
  candidates: Array<{ kind: "file" | "dir" | "mcp" | "git" | "skill"; value: string; label: string; detail?: string }>;
}> {
  return host.call("workspace/complete", { query, ...opts });
}

/** Subscribe to debounced disk-change notifications for a directory. */
export async function watchWorkspace(
  host: ClientRpcHost,
  path = ".",
  cwd?: string,
): Promise<{ watching: boolean; path: string }> {
  return host.call("workspace/watch", { path, cwd });
}

export async function gitDiff(
  host: ClientRpcHost,
  path?: string,
  staged = false,
  cwd?: string,
): Promise<{ path?: string; diff: string; truncated: boolean }> {
  return host.call("workspace/git-diff", { path, staged, cwd });
}

export async function gitStatus(
  host: ClientRpcHost,
  cwd?: string,
): Promise<{ branch: string; files: Array<{ path: string; index: string; worktree: string; status: string }> }> {
  return host.call("workspace/git-status", { cwd });
}

export async function gitBranches(
  host: ClientRpcHost,
  cwd?: string,
): Promise<{ current: string; branches: Array<{ name: string; current: boolean; upstream?: string; ahead?: number; behind?: number }>; tags: string[]; detached: boolean }> {
  return host.call("git/branches", { cwd });
}

export async function gitInit(host: ClientRpcHost, cwd?: string): Promise<{ ok: boolean; output: string }> {
  return host.call("git/init", { cwd });
}

export async function gitStage(
  host: ClientRpcHost,
  paths?: string[],
  cwd?: string,
): Promise<{ ok: boolean; output: string }> {
  return host.call("git/stage", { paths, cwd });
}

export async function gitUnstage(
  host: ClientRpcHost,
  paths?: string[],
  cwd?: string,
): Promise<{ ok: boolean; output: string }> {
  return host.call("git/unstage", { paths, cwd });
}

export async function gitCommit(
  host: ClientRpcHost,
  message: string,
  all = false,
  cwd?: string,
): Promise<{ ok: boolean; output: string }> {
  return host.call("git/commit", { message, all, cwd });
}

export async function gitPush(
  host: ClientRpcHost,
  opts: { remote?: string; branch?: string; setUpstream?: boolean; cwd?: string } = {},
): Promise<{ ok: boolean; output: string }> {
  return host.call("git/push", opts);
}

export async function gitPull(
  host: ClientRpcHost,
  opts: { remote?: string; branch?: string; cwd?: string } = {},
): Promise<{ ok: boolean; output: string }> {
  return host.call("git/pull", opts);
}

export async function gitFetch(host: ClientRpcHost, cwd?: string): Promise<{ ok: boolean; output: string }> {
  return host.call("git/fetch", { cwd });
}

export async function gitCheckout(
  host: ClientRpcHost,
  branch: string,
  create = false,
  cwd?: string,
): Promise<{ ok: boolean; output: string }> {
  return host.call("git/checkout", { branch, create, cwd });
}

export async function gitCommitMessage(
  host: ClientRpcHost,
  cwd?: string,
  sessionId?: string,
): Promise<{ message: string }> {
  return host.call("git/commit-message", { cwd, sessionId });
}

export async function writeWorkspace(
  host: ClientRpcHost,
  path: string,
  content: string,
  expectedSize?: number,
  expectedHash?: string,
  cwd?: string,
): Promise<{ path: string; size: number; hash: string }> {
  return host.call("workspace/write", { path, content, expectedSize, expectedHash, cwd });
}

export async function searchWorkspace(
  host: ClientRpcHost,
  query: string,
  path = ".",
  maxResults = 100,
  cwd?: string,
): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
  return host.call("workspace/search", { query, path, maxResults, cwd });
}

export async function readWorkspace(
  host: ClientRpcHost,
  path: string,
  cwd?: string,
): Promise<{
  path: string;
  content: string;
  size: number;
  hash: string;
  truncated: boolean;
  encoding?: "utf8" | "base64";
  mediaType?: string;
}> {
  return host.call("workspace/read", { path, cwd });
}

/** Resolve a (bare/relative) path to an absolute one the host can open,
 * using the server's workspace basename fallback. */
export async function resolveWorkspace(
  host: ClientRpcHost,
  path: string,
  cwd?: string,
): Promise<{
  path: string;
  absolute: string;
  exists: boolean;
}> {
  return host.call("workspace/resolve", { path, cwd });
}

export async function initWorkspace(
  host: ClientRpcHost,
  opts?: {
    force?: boolean;
    filename?: "AGENTS.md" | "CODEPILOT.md";
  },
): Promise<{ path: string; created: boolean; skipped: boolean }> {
  return host.call("workspace/init", opts ?? {});
}