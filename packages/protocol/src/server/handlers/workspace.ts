import { readdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, relative, resolve, dirname, sep, isAbsolute } from "node:path";
import {
  discoverSlashCommands,
  discoverSkills,
  discoverPlugins,
  pluginResourcePaths,
  sharedBuiltinCommands,
  listMcpPromptSlashCommands,
  expandMcpPromptCommand,
  renderCommandPrompt,
  findSlashCommand,
  type Session,
  type SlashCommand,
} from "@codepilot/core";
import { parseReference } from "../../paths.js";
import { ErrorCode, RpcError } from "../../rpc.js";
import {
  assertCwdInGrantScope,
  assertInitialized,
  WORKSPACE_MAX_BYTES,
  workspacePath,
  type ServerContext,
} from "../context.js";
import type {
  CommandInfoRpc,
  CommandsExpandParams,
  CommandsExpandResult,
  CommandsListParams,
  CommandsListResult,
  CompletionCandidate,
  CompletionKind,
  WorkspaceBrowseParams,
  WorkspaceBrowseResult,
  WorkspaceChangedParams,
  WorkspaceCompleteParams,
  WorkspaceCompleteResult,
  WorkspaceEntry,
  WorkspaceListParams,
  WorkspaceListResult,
  WorkspacePickFolderResult,
  WorkspaceReadParams,
  WorkspaceReadResult,
  WorkspaceResolveParams,
  WorkspaceResolveResult,
  WorkspaceSearchParams,
  WorkspaceSearchResult,
  WorkspaceStatParams,
  WorkspaceStatResult,
  WorkspaceWatchParams,
  WorkspaceWatchResult,
  WorkspaceWriteParams,
  WorkspaceWriteResult,
} from "../wireTypes.js";

const execFileAsync = promisify(execFile);

export async function handleWorkspaceList(
  ctx: ServerContext,
  params: WorkspaceListParams,
): Promise<WorkspaceListResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
  const entries: WorkspaceEntry[] = [];
  for (const name of await readdir(target.abs)) {
    const abs = join(target.abs, name);
    const info = await stat(abs);
    entries.push({
      name,
      path: join(target.rel, name),
      kind: info.isDirectory() ? "directory" : "file",
      size: info.isFile() ? info.size : undefined,
    });
  }
  entries.sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name),
  );
  return { path: target.rel, entries };
}

/** Open a native folder chooser on the machine running `codepilot serve`. */
export async function handleWorkspacePickFolder(): Promise<WorkspacePickFolderResult> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Open workspace")',
      ]);
      const path = stdout.trim().replace(/\/+$/, "");
      return { path: path || null, supported: true };
    }
    if (platform === "linux") {
      try {
        const { stdout } = await execFileAsync("zenity", [
          "--file-selection",
          "--directory",
          "--title=Open workspace",
        ]);
        const path = stdout.trim().replace(/\/+$/, "");
        return { path: path || null, supported: true };
      } catch {
        const { stdout } = await execFileAsync("kdialog", [
          "--getexistingdirectory",
          homedir(),
          "--title",
          "Open workspace",
        ]);
        const path = stdout.trim().replace(/\/+$/, "");
        return { path: path || null, supported: true };
      }
    }
    if (platform === "win32") {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        "$d.Description = 'Open workspace'; " +
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
      const path = stdout.trim().replace(/\/+$/, "");
      return { path: path || null, supported: true };
    }
  } catch {
    // Cancel or missing dialog tool — fall through to in-app browser.
    return { path: null, supported: true };
  }
  return { path: null, supported: false };
}

export async function handleWorkspaceBrowse(
  ctx: ServerContext,
  params: WorkspaceBrowseParams,
): Promise<WorkspaceBrowseResult> {
  assertInitialized(ctx);
  const home = homedir();
  const roots = [
    { label: "Home", path: home },
    { label: "Serve cwd", path: resolve(ctx.defaultCwd) },
    { label: "/", path: "/" },
  ];
  const requested = (params.path ?? home).trim() || home;
  const abs = resolve(requested);
  const info = await stat(abs).catch(() => null);
  if (!info?.isDirectory()) {
    throw new RpcError(ErrorCode.InvalidRequest, `not a directory: ${abs}`);
  }
  const entries: WorkspaceBrowseResult["entries"] = [];
  for (const name of await readdir(abs)) {
    if (name.startsWith(".")) continue;
    const child = join(abs, name);
    const childInfo = await stat(child).catch(() => null);
    if (!childInfo) continue;
    entries.push({
      name,
      path: child,
      kind: childInfo.isDirectory() ? "directory" : "file",
    });
  }
  entries.sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name),
  );
  const parent = abs === "/" ? undefined : dirname(abs);
  return { path: abs, parent, entries, roots };
}

const IMAGE_EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

export async function handleWorkspaceRead(
  ctx: ServerContext,
  params: WorkspaceReadParams,
): Promise<WorkspaceReadResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
  let abs = target.abs;
  let rel = target.rel;
  let data: Buffer;
  try {
    data = await readFile(abs);
  } catch (err) {
    // The path didn't resolve. Common case: the model referenced a file by a
    // bare name or repo-relative path. Search the workspace for a file whose
    // path ends with the requested suffix and open the shallowest match.
    // Only for not-found; other errors propagate.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const root = resolve(params.cwd && params.cwd.trim() ? params.cwd : ctx.defaultCwd);
    const found = await resolveByBasename(root, params.path);
    if (!found) throw err;
    abs = found;
    rel = relative(root, abs) || abs;
    data = await readFile(abs);
  }
  const truncated = data.byteLength > WORKSPACE_MAX_BYTES;
  const slice = data.subarray(0, WORKSPACE_MAX_BYTES);
  const hash = createHash("sha256").update(data).digest("hex");
  const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")).toLowerCase() : "";
  const mediaType = IMAGE_EXT_MIME[ext];
  if (mediaType) {
    return {
      path: rel,
      content: slice.toString("base64"),
      size: data.byteLength,
      hash,
      truncated,
      encoding: "base64",
      mediaType,
    };
  }
  return {
    path: rel,
    content: slice.toString("utf8"),
    size: data.byteLength,
    hash,
    truncated,
    encoding: "utf8",
  };
}

/** Resolve a (possibly bare / relative) path to an absolute one the host
 * should open. Direct join first; on miss falls back to the workspace basename
 * search. Source of truth for "turn a referenced path into something openable". */
export async function handleWorkspaceResolve(
  ctx: ServerContext,
  params: WorkspaceResolveParams,
): Promise<WorkspaceResolveResult> {
  assertInitialized(ctx);
  const root = resolve(params.cwd && params.cwd.trim() ? params.cwd : ctx.defaultCwd);
  const target = workspacePath(ctx, params.path, params.cwd);
  const direct = await stat(target.abs)
    .then(() => true)
    .catch(() => false);
  if (direct) {
    return { path: target.rel, absolute: target.abs, exists: true };
  }
  const found = await resolveByBasename(root, params.path);
  if (found) {
    return { path: relative(root, found) || found, absolute: found, exists: true };
  }
  // Nothing matched: hand back the best-effort join so the caller can still
  // decide what to do (and show a sensible path), but mark it non-existent.
  return { path: target.rel, absolute: target.abs, exists: false };
}

/** Best-effort fallback: search the workspace for a file whose path ends with
 * the requested suffix, returning the shallowest unique match. Returns null on
 * no match or ambiguity. Skips noise dirs; stays inside `root`. */
async function resolveByBasename(root: string, requested: string | undefined): Promise<string | null> {
  if (!requested) return null;
  const want = parseReference(requested).path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!want || want.includes("..")) return null;
  const base = want.split("/").pop() ?? want;
  if (!base) return null;
  // Candidates ranked by: exact relative-suffix match first, then basename;
  // within a rank, shallowest path. Bounded walk so a huge tree can't hang.
  const suffixMatches: string[] = [];
  const baseMatches: string[] = [];
  let visited = 0;
  const MAX_VISIT = 20_000;
  async function walk(dir: string): Promise<void> {
    if (visited > MAX_VISIT) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git" || name === "node_modules" || name === ".codepilot" || name === "dist") continue;
      const abs = join(dir, name);
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      visited++;
      if (info.isDirectory()) {
        await walk(abs);
      } else if (info.isFile()) {
        const relPath = relative(root, abs).replace(/\\/g, "/");
        if (relPath === want || relPath.endsWith("/" + want)) suffixMatches.push(abs);
        else if (name === base) baseMatches.push(abs);
      }
    }
  }
  await walk(root);
  const pick = (list: string[]): string | null => {
    if (list.length === 0) return null;
    // Shallowest path wins (closest to the workspace root is the likeliest
    // intended file); ties broken by locale order for determinism.
    return [...list].sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    )[0]!;
  };
  return pick(suffixMatches) ?? pick(baseMatches);
}

export async function handleWorkspaceSearch(
  ctx: ServerContext,
  params: WorkspaceSearchParams,
): Promise<WorkspaceSearchResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
  const root = target.abs;
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    throw new RpcError(ErrorCode.InvalidRequest, `workspace search path is not a directory: ${target.rel}`);
  }
  const query = params.query.trim();
  if (!query) return { matches: [], truncated: false };
  const max = Math.min(Math.max(params.maxResults ?? 100, 1), 1000);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let stopped = false;
  async function walk(dir: string): Promise<void> {
    if (stopped) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git" || name === "node_modules" || name === ".codepilot") continue;
      const abs = join(dir, name);
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) await walk(abs);
      else if (info.isFile() && info.size <= WORKSPACE_MAX_BYTES) {
        try {
          const text = await readFile(abs, "utf8");
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.toLowerCase().includes(query.toLowerCase())) {
              matches.push({
                path: relative(resolve(ctx.defaultCwd), abs),
                line: i + 1,
                text: lines[i]!,
              });
              if (matches.length >= max) {
                stopped = true;
                break;
              }
            }
          }
        } catch {
          /* binary/unreadable files are skipped */
        }
      }
      if (stopped) return;
    }
  }
  await walk(root);
  return { matches, truncated: stopped };
}

/** List slash commands for the `/` menu: shared built-ins + project/user
 * markdown commands. Shared across every client surface — the TUI, web, and
 * IDE clients all render the same set. Client-only built-ins (exit, remote,
 * connect) are intentionally omitted (they live in the client). */
export async function handleCommandsList(
  ctx: ServerContext,
  params?: CommandsListParams,
): Promise<CommandsListResult> {
  assertInitialized(ctx);
  assertCwdInGrantScope(ctx, params?.cwd);
  const cwd = params?.cwd?.trim() ? resolve(params.cwd) : resolve(ctx.defaultCwd);
  const commands: CommandInfoRpc[] = sharedBuiltinCommands().map((c) => ({
    name: c.name,
    description: c.description,
    argumentHint: c.argumentHint,
    source: "builtin" as const,
    kind: c.kind,
  }));
  const warnings: string[] = [];
  try {
    const reserved = new Set(commands.map((c) => c.name));
    // Plugin command dirs: discovered fail-soft so a bad plugin never breaks
    // the `/` menu. Mapped to the "user" RPC source to avoid a wire-type change.
    let extraDirs: string[] = [];
    try {
      const plugins = await discoverPlugins(cwd);
      extraDirs = pluginResourcePaths(plugins).commands;
    } catch {
      /* plugin discovery is best-effort; fall back to project/user commands */
    }
    const discovered = await discoverSlashCommands(cwd, { reservedNames: reserved, extraDirs });
    for (const c of discovered.commands) {
      commands.push({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        // Markdown commands keep their true source (project / user / plugin);
        // they always expand into a model turn, so kind is "prompt".
        source: c.source,
        kind: "prompt",
      });
    }
    warnings.push(...discovered.warnings);
    // MCP prompts as dynamic slash commands (live from a session's manager).
    const taken = new Set(commands.map((c) => c.name.toLowerCase()));
    const session = liveSessionForCwd(ctx, cwd);
    const mcpCmds = listMcpPromptSlashCommands(session?.getMcpManager?.() ?? null, {
      takenNames: taken,
      onWarn: (msg) => warnings.push(msg),
    });
    for (const c of mcpCmds) {
      commands.push({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        source: "mcp",
        kind: "prompt",
      });
    }
  } catch (err) {
    warnings.push(`slash-command discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { commands, warnings };
}

/** Discover markdown + MCP prompt slash commands for a cwd (shared by list/expand). */
async function discoverAllPromptCommands(
  ctx: ServerContext,
  cwd: string,
): Promise<{ commands: SlashCommand[]; warnings: string[] }> {
  const warnings: string[] = [];
  const reserved = new Set(sharedBuiltinCommands().map((c) => c.name));
  let extraDirs: string[] = [];
  try {
    const plugins = await discoverPlugins(cwd);
    extraDirs = pluginResourcePaths(plugins).commands;
  } catch {
    /* best-effort */
  }
  const discovered = await discoverSlashCommands(cwd, { reservedNames: reserved, extraDirs });
  warnings.push(...discovered.warnings);
  const taken = new Set([
    ...reserved,
    ...discovered.commands.map((c) => c.name.toLowerCase()),
  ]);
  const session = liveSessionForCwd(ctx, cwd);
  const mcpCmds = listMcpPromptSlashCommands(session?.getMcpManager?.() ?? null, {
    takenNames: taken,
    onWarn: (msg) => warnings.push(msg),
  });
  return { commands: [...discovered.commands, ...mcpCmds], warnings };
}

/** Expand a prompt-kind slash command into user-turn text (markdown or MCP). */
export async function handleCommandsExpand(
  ctx: ServerContext,
  params: CommandsExpandParams,
): Promise<CommandsExpandResult> {
  assertInitialized(ctx);
  assertCwdInGrantScope(ctx, params?.cwd);
  const cwd = params?.cwd?.trim() ? resolve(params.cwd) : resolve(ctx.defaultCwd);
  const name = (params.name ?? "").trim().replace(/^\//, "");
  if (!name) {
    throw new RpcError(ErrorCode.InvalidParams, "commands/expand requires name");
  }
  const { commands } = await discoverAllPromptCommands(ctx, cwd);
  const cmd = findSlashCommand(commands, name);
  if (!cmd) {
    throw new RpcError(ErrorCode.InvalidParams, `unknown command: /${name}`);
  }
  const args = (params.args ?? "").trim();
  if (cmd.argumentHint && args.length === 0) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `Usage: /${cmd.name} ${cmd.argumentHint}`,
    );
  }
  if (cmd.mcpPrompt) {
    const session = liveSessionForCwd(ctx, cwd);
    const mcp = session?.getMcpManager?.() ?? null;
    if (!mcp) {
      throw new RpcError(ErrorCode.InvalidRequest, "MCP not ready — cannot expand prompt command");
    }
    const prompt = await expandMcpPromptCommand(cmd, args, mcp);
    return { prompt, source: "mcp", model: cmd.model, allowedTools: cmd.allowedTools };
  }
  return {
    prompt: renderCommandPrompt(cmd, args),
    source: cmd.source,
    model: cmd.model,
    allowedTools: cmd.allowedTools,
  };
}

/** First live session whose cwd matches (for MCP resource listing). Falls back
 * to any live session, or null. */
function liveSessionForCwd(ctx: ServerContext, cwd: string): Session | null {
  const want = resolve(cwd);
  let any: Session | null = null;
  for (const s of ctx.sessions.values()) {
    any = s;
    try {
      if (resolve(s.getCwd?.() ?? ctx.defaultCwd) === want) return s;
    } catch {
      /* ignore */
    }
  }
  return any;
}

const COMPLETION_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".codepilot",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".idea",
  ".gradle",
]);

/** Split `@file:` query into a directory prefix (browse scope) and basename filter.
 * Empty query or a trailing `/` → scoped child listing; bare fragment → fuzzy walk. */
export function splitCompletionPathQuery(query: string): {
  dirPrefix: string;
  base: string;
  scoped: boolean;
} {
  const norm = query.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || norm === "/") return { dirPrefix: "", base: "", scoped: true };
  const slash = norm.lastIndexOf("/");
  if (slash < 0) return { dirPrefix: "", base: norm, scoped: false };
  return {
    dirPrefix: norm.slice(0, slash + 1),
    base: norm.slice(slash + 1),
    scoped: true,
  };
}

function pathUnderCwd(cwd: string, abs: string): boolean {
  const rel = relative(cwd, abs);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Immediate children of `cwd/dirPrefix`, filtered by basename, dirs first. */
async function listScopedCompletionChildren(
  cwd: string,
  dirPrefix: string,
  baseFilter: string,
  opts: { wantFile: boolean; wantDir: boolean; /** When browsing @file, still emit dirs for drill-in. */ includeDirsForBrowse: boolean },
  max: number,
): Promise<{ hits: CompletionCandidate[]; truncated: boolean }> {
  const target = dirPrefix ? resolve(cwd, dirPrefix) : cwd;
  if (!pathUnderCwd(cwd, target)) return { hits: [], truncated: false };
  let names: string[];
  try {
    names = await readdir(target);
  } catch {
    return { hits: [], truncated: false };
  }
  const bl = baseFilter.toLowerCase();
  const rows: Array<{ rel: string; dir: boolean; name: string }> = [];
  for (const name of names) {
    if (COMPLETION_IGNORE_DIRS.has(name)) continue;
    if (name.startsWith(".") && !bl.startsWith(".")) continue;
    if (bl && !name.toLowerCase().includes(bl)) continue;
    const abs = join(target, name);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    const isDir = info.isDirectory();
    if (isDir) {
      if (!opts.wantDir && !opts.includeDirsForBrowse) continue;
    } else if (!opts.wantFile) {
      continue;
    }
    const rel = relative(cwd, abs).replace(/\\/g, "/");
    rows.push({ rel, dir: isDir, name });
  }
  rows.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const truncated = rows.length > max;
  const hits = rows.slice(0, max).map((r) => {
    if (r.dir) {
      const value = r.rel.endsWith("/") ? r.rel : `${r.rel}/`;
      return {
        kind: "dir" as const,
        value,
        label: value,
        detail: "directory",
      };
    }
    return { kind: "file" as const, value: r.rel, label: r.rel };
  });
  return { hits, truncated };
}

/** Fuzzy path walk when the user typed a bare fragment (no `/`). */
async function fuzzyCompletionWalk(
  cwd: string,
  ql: string,
  opts: { wantFile: boolean; wantDir: boolean; includeDirsForBrowse: boolean },
  max: number,
): Promise<{ hits: CompletionCandidate[]; truncated: boolean }> {
  const hits: Array<{ rel: string; dir: boolean; score: number }> = [];
  let visited = 0;
  let more = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited > 4000 || depth > 8) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (COMPLETION_IGNORE_DIRS.has(name)) continue;
      if (name.startsWith(".") && !ql.startsWith(".")) continue;
      visited++;
      const abs = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      const rel = relative(cwd, abs).replace(/\\/g, "/");
      const rell = rel.toLowerCase();
      const isDir = info.isDirectory();
      const allowDir = isDir && (opts.wantDir || opts.includeDirsForBrowse);
      const allowFile = !isDir && opts.wantFile;
      if (allowDir || allowFile) {
        if (!ql || rell.includes(ql) || name.toLowerCase().includes(ql)) {
          const base = name.toLowerCase();
          const score =
            (base === ql ? 0 : base.startsWith(ql) ? 1 : base.includes(ql) ? 2 : 3) * 100 +
            rel.split(/[/\\]/).length;
          hits.push({ rel, dir: isDir, score });
        }
      }
      if (isDir) await walk(abs, depth + 1);
      if (hits.length > max * 8) {
        more = true;
        return;
      }
    }
  };
  await walk(cwd, 0);
  hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
  more = more || hits.length > max;
  const slice = hits.slice(0, max).map((h) => {
    if (h.dir) {
      const value = h.rel.endsWith("/") ? h.rel : `${h.rel}/`;
      return { kind: "dir" as const, value, label: value, detail: "directory" };
    }
    return { kind: "file" as const, value: h.rel, label: h.rel };
  });
  return { hits: slice, truncated: more };
}

/** Unified `@`-mention completion: server ranks candidates across kinds
 * (file/dir/mcp/git/skill); the inserted `value` is a token the agent
 * resolves at prompt time (server does not inline content). */
export async function handleWorkspaceComplete(
  ctx: ServerContext,
  params: WorkspaceCompleteParams,
): Promise<WorkspaceCompleteResult> {
  assertInitialized(ctx);
  assertCwdInGrantScope(ctx, params.cwd);
  const cwd = params.cwd?.trim() ? resolve(params.cwd) : resolve(ctx.defaultCwd);
  const query = (params.query ?? "").trim();
  const ql = query.toLowerCase();
  // Small default: completeness comes from path-scoped browse + typing, not a long dump.
  const max = Math.min(Math.max(params.maxResults ?? 40, 1), 100);
  const kinds = new Set<CompletionKind>(params.kinds ?? ["file", "dir", "mcp", "git", "skill"]);
  const out: CompletionCandidate[] = [];
  let truncated = false;

  // --- files + dirs: path-scoped child listing when empty or `dir/…`; else fuzzy.
  if (kinds.has("file") || kinds.has("dir")) {
    const wantFile = kinds.has("file");
    const wantDir = kinds.has("dir");
    // @file: still returns directories so the menu can drill in with keepOpen.
    const includeDirsForBrowse = wantFile;
    const { dirPrefix, base, scoped } = splitCompletionPathQuery(query);
    const fileHits = scoped
      ? await listScopedCompletionChildren(cwd, dirPrefix, base, { wantFile, wantDir, includeDirsForBrowse }, max)
      : await fuzzyCompletionWalk(cwd, ql, { wantFile, wantDir, includeDirsForBrowse }, max);
    out.push(...fileHits.hits);
    truncated = truncated || fileHits.truncated;
  }

  // --- MCP resources from a live session's manager (if any).
  if (kinds.has("mcp")) {
    try {
      const session = liveSessionForCwd(ctx, cwd);
      const mcp = session?.getMcpManager?.() ?? null;
      const resources = mcp ? mcp.listAllResources() : [];
      for (const r of resources) {
        const ref = `@mcp:${r.server}/${r.uri.replace(/^[a-z]+:\/\//i, "")}`;
        const label = r.name ?? r.uri;
        if (!ql || ref.toLowerCase().includes(ql) || label.toLowerCase().includes(ql)) {
          out.push({ kind: "mcp", value: ref, label, detail: `[mcp:${r.server}]` });
        }
      }
    } catch {
      /* MCP optional */
    }
  }

  // --- git: changed files (so `@git:path` or `@path` of a dirty file is easy).
  if (kinds.has("git")) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "-uall"]);
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const p = line.slice(3);
        if (!ql || p.toLowerCase().includes(ql)) {
          out.push({
            kind: "git",
            value: p,
            label: p,
            detail: `git ${line.slice(0, 2).trim() || "·"}`,
          });
        }
      }
    } catch {
      /* not a repo */
    }
  }

  // --- skills (so a user can reference a skill by name).
  if (kinds.has("skill")) {
    try {
      const skills = await discoverSkills(cwd);
      for (const s of skills) {
        if (!ql || s.name.toLowerCase().includes(ql)) {
          out.push({
            kind: "skill",
            value: s.name,
            label: s.name,
            detail: s.description?.slice(0, 80),
          });
        }
      }
    } catch {
      /* skills optional */
    }
  }

  if (out.length > max) truncated = true;
  return { candidates: out.slice(0, max), truncated };
}

export async function handleWorkspaceStat(
  ctx: ServerContext,
  params: WorkspaceStatParams,
): Promise<WorkspaceStatResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
  try {
    const info = await stat(target.abs);
    if (!info.isFile()) return { path: target.rel, exists: false, size: 0, hash: "" };
    const data = await readFile(target.abs);
    return {
      path: target.rel,
      exists: true,
      size: info.size,
      hash: createHash("sha256").update(data).digest("hex"),
      modifiedAt: info.mtimeMs,
    };
  } catch {
    return { path: target.rel, exists: false, size: 0, hash: "" };
  }
}

const WATCH_DEBOUNCE_MS = 150;

export function stopWatcher(ctx: ServerContext): void {
  const w = ctx.watcher;
  if (!w) return;
  ctx.watcher = undefined;
  if (w.debounce) clearTimeout(w.debounce);
  try {
    w.watcher.close();
  } catch {
    /* already closed */
  }
}

export async function handleWorkspaceWatch(
  ctx: ServerContext,
  params: WorkspaceWatchParams,
): Promise<WorkspaceWatchResult> {
  assertInitialized(ctx);
  stopWatcher(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
  const info = await stat(target.abs).catch(() => null);
  if (!info?.isDirectory()) {
    throw new RpcError(ErrorCode.InvalidRequest, `workspace watch path is not a directory: ${target.rel}`);
  }
  const root = resolve(ctx.defaultCwd);
  let watcher: FSWatcher;
  try {
    watcher = watch(target.abs, { recursive: true }, (kind, filename) => {
      if (!filename) return;
      const rel = relative(root, resolve(target.abs, filename));
      if (!rel || rel.startsWith("..")) return;
      const top = rel.split("/")[0];
      if (top === ".git" || top === "node_modules" || top === ".codepilot") return;
      const entry = ctx.watcher;
      if (!entry) return;
      entry.kinds.add(kind === "rename" ? "rename" : "change");
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(() => {
        entry.debounce = undefined;
        const kinds = Array.from(entry.kinds);
        entry.kinds.clear();
        void ctx.peer
          .notify<WorkspaceChangedParams>("workspace/changed", { path: entry.path, kinds })
          .catch(() => {});
      }, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      `workspace watch unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const entry = { watcher, kinds: new Set<"rename" | "change">(), path: target.rel };
  ctx.watcher = entry;
  watcher.on("error", (err) => {
    // A broken watcher must not silently stop notifying: tell the client to
    // fall back to polling, then drop the watcher.
    if (ctx.watcher === entry) stopWatcher(ctx);
    void ctx.peer
      .notify<WorkspaceChangedParams>("workspace/changed", {
        path: target.rel,
        kinds: [],
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});
  });
  return { watching: true, path: target.rel };
}

export async function handleWorkspaceWrite(
  ctx: ServerContext,
  params: WorkspaceWriteParams,
): Promise<WorkspaceWriteResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
  if (Buffer.byteLength(params.content, "utf8") > WORKSPACE_MAX_BYTES) {
    throw new RpcError(ErrorCode.InvalidRequest, "workspace file exceeds 512 KiB");
  }
  const current = await readFile(target.abs).catch(() => Buffer.alloc(0));
  const currentHash = createHash("sha256").update(current).digest("hex");
  if (params.expectedSize !== undefined && current.byteLength !== params.expectedSize) {
    throw new RpcError(ErrorCode.InvalidRequest, "file changed since it was loaded");
  }
  if (params.expectedHash !== undefined && currentHash !== params.expectedHash) {
    throw new RpcError(ErrorCode.InvalidRequest, "file changed since it was loaded");
  }
  const next = Buffer.from(params.content, "utf8");
  const hash = createHash("sha256").update(next).digest("hex");
  const temp = `${target.abs}.codepilot-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, target.abs);
  return { path: target.rel, size: next.byteLength, hash };
}