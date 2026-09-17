/**
 * CodePilot headless protocol server (docs/PROTOCOL.md).
 *
 * Bridges `@codepilot/core`'s `Session` API onto a JSON-RPC 2.0 NDJSON
 * transport. One process can serve many sessions; each session is held in a
 * `Map` and its events are forwarded as `event` notifications to the client.
 *
 * Lifecycle:
 *  1. client calls `initialize` (negotiates protocolVersion, exchanges cwd).
 *  2. client opens sessions with `session/new` / `session/resume`.
 *  3. client streams prompts via `prompt/send`; events come back as `event`
 *     notifications. The server may issue a `permission/request` reverse
 *     request when core's `onPermissionRequest` is invoked; client replies
 *     with `permission/respond` and we resolve the pending promise.
 *  4. `shutdown` returns and we close the peer.
 */

import { readdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { join, relative, resolve } from "node:path";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  PermissionDecision,
  PermissionMode,
  PermissionRequest as CorePermissionRequest,
  QuestionAnswers,
  QuestionRequest as CoreQuestionRequest,
  Session,
  SessionSummary,
  UsageInfo,
} from "@codepilot/core";
import {
  createSession,
  listSessions as coreListSessions,
  loadConfig as coreLoadConfig,
} from "@codepilot/core";
import { ErrorCode, Peer, RpcError, StdioTransport } from "./rpc.js";

/** Mirrors docs/PROTOCOL.md's `event` notification params. */
export interface EventParams {
  sessionId: string;
  event: Event;
}

export interface UsageParams {
  sessionId: string;
  usage: UsageInfo;
}

export interface InitializeParams {
  protocolVersion: number;
  cwd: string;
  permissionMode: PermissionMode;
  clientInfo: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: number;
  capabilities: {
    tools: string[];
    providers: string[];
    /** Supported collaboration modes (per docs/PROTOCOL.md). */
    modes: AgentMode[];
  };
}

export interface SessionNewParams {
  cwd?: string;
  model?: string;
  systemPromptExtra?: string;
  /** Initial collaboration mode (default "agent"). */
  agentMode?: AgentMode;
}

export interface SessionResumeParams {
  sessionId: string;
}

export interface SessionResumeResult {
  sessionId: string;
  events: Event[];
}

export interface SessionListResult {
  sessions: SessionSummary[];
}

export interface WorkspaceListParams { path?: string; }
export interface WorkspaceEntry { name: string; path: string; kind: "file" | "directory"; size?: number; }
export interface WorkspaceListResult { path: string; entries: WorkspaceEntry[]; }
export interface WorkspaceReadParams { path: string; }
export interface WorkspaceReadResult { path: string; content: string; size: number; hash: string; truncated: boolean; }
export interface WorkspaceSearchParams { query: string; path?: string; maxResults?: number; }
export interface WorkspaceSearchResult { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; }
export interface WorkspaceWriteParams { path: string; content: string; expectedSize?: number; expectedHash?: string; }
export interface WorkspaceWriteResult { path: string; size: number; hash: string; }
export interface WorkspaceGitStatusResult { branch: string; files: Array<{ path: string; index: string; worktree: string; status: string }>; }
export interface WorkspaceGitDiffParams { path?: string; staged?: boolean; }
export interface WorkspaceGitDiffResult { path?: string; diff: string; truncated: boolean; }
export interface WorkspaceStatParams { path: string; }
export interface WorkspaceStatResult { path: string; exists: boolean; size: number; hash: string; modifiedAt?: number; }

export interface PromptSendParams {
  sessionId: string;
  text: string;
  images?: { mediaType: string; base64: string }[];
}

export interface PromptCancelParams {
  sessionId: string;
}

export interface PermissionRespondParams {
  requestId: string;
  decision: PermissionDecision;
}

export interface QuestionRespondParams {
  requestId: string;
  /** Answers keyed by question id: option label(s) or free text. */
  answers: QuestionAnswers;
}

export interface SessionForkParams {
  sessionId: string;
  atEventIndex?: number;
}

/**
 * Wire params for `session/setMode`: change a session's collaboration
 * mode at runtime (see docs/PROTOCOL.md).
 */
export interface SessionSetModeParams {
  sessionId: string;
  mode: AgentMode;
}

/** Wire params for the reverse request we send to the client. */
export interface PermissionRequestParams {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
}

/** Wire params for the reverse `question/request` (ask_user_question / plan_done). */
export interface QuestionRequestParams {
  sessionId: string;
  requestId: string;
  questions: CoreQuestionRequest["questions"];
}

export const PROTOCOL_VERSION = 1;
/** All collaboration modes advertised by the server. */
export const SUPPORTED_MODES: AgentMode[] = ["chat", "plan", "agent"];

/**
 * Wire up RPC handlers on an existing `Peer`. Exposed for tests; production
 * code uses {@link startServer}.
 */
export function registerServer(
  peer: Peer,
  opts: ServerOptions = {},
): ServerHandle {
  const ctx: ServerContext = {
    peer,
    sessions: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    defaultCwd: opts.defaultCwd ?? process.cwd(),
    defaultPermissionMode: opts.defaultPermissionMode ?? "ask",
    capabilities: opts.capabilities ?? defaultCapabilities(),
    initialized: false,
  };

  peer.onRequest<InitializeParams, InitializeResult>("initialize", (p) =>
    handleInitialize(ctx, p),
  );
  peer.onRequest<SessionNewParams, { sessionId: string }>("session/new", (p) =>
    handleSessionNew(ctx, p),
  );
  peer.onRequest<SessionSetModeParams, Record<string, never>>(
    "session/setMode",
    (p) => handleSessionSetMode(ctx, p),
  );
  peer.onRequest<SessionResumeParams, SessionResumeResult>(
    "session/resume",
    (p) => handleSessionResume(ctx, p),
  );
  peer.onRequest<{}, SessionListResult>("session/list", () =>
    handleSessionList(ctx),
  );
  peer.onRequest<WorkspaceListParams, WorkspaceListResult>("workspace/list", (p) =>
    handleWorkspaceList(ctx, p),
  );
  peer.onRequest<WorkspaceReadParams, WorkspaceReadResult>("workspace/read", (p) =>
    handleWorkspaceRead(ctx, p),
  );
  peer.onRequest<WorkspaceSearchParams, WorkspaceSearchResult>("workspace/search", (p) =>
    handleWorkspaceSearch(ctx, p),
  );
  peer.onRequest<WorkspaceWriteParams, WorkspaceWriteResult>("workspace/write", (p) =>
    handleWorkspaceWrite(ctx, p),
  );
  peer.onRequest<{}, WorkspaceGitStatusResult>("workspace/git-status", () => handleWorkspaceGitStatus(ctx));
  peer.onRequest<WorkspaceGitDiffParams, WorkspaceGitDiffResult>("workspace/git-diff", (p) => handleWorkspaceGitDiff(ctx, p));
  peer.onRequest<WorkspaceStatParams, WorkspaceStatResult>("workspace/stat", (p) => handleWorkspaceStat(ctx, p));
  peer.onRequest<PromptSendParams, Record<string, never>>(
    "prompt/send",
    (p) => handlePromptSend(ctx, p),
  );
  peer.onRequest<PromptCancelParams, Record<string, never>>(
    "prompt/cancel",
    (p) => handlePromptCancel(ctx, p),
  );
  peer.onRequest<PermissionRespondParams, Record<string, never>>(
    "permission/respond",
    (p) => handlePermissionRespond(ctx, p),
  );
  peer.onRequest<QuestionRespondParams, Record<string, never>>(
    "question/respond",
    (p) => handleQuestionRespond(ctx, p),
  );
  peer.onRequest<SessionForkParams, { sessionId: string }>(
    "session/fork",
    (p) => handleSessionFork(ctx, p),
  );
  peer.onRequest<{}, Record<string, never>>("shutdown", () =>
    handleShutdown(ctx),
  );

  return {
    peer,
    close: () => peer.close(),
    dispose: () => teardown(ctx),
  };
}

export interface ServerOptions {
  defaultCwd?: string;
  defaultPermissionMode?: PermissionMode;
  capabilities?: InitializeResult["capabilities"];
}

export interface ServerHandle {
  peer: Peer;
  close(): Promise<void>;
  /**
   * Release everything this connection owns: unsubscribe from session events,
   * dispose the sessions, and fail-closed on any outstanding permission /
   * question requests. `shutdown` does this for a well-behaved client; a
   * transport that can drop without warning (a closed browser tab over
   * WebSocket) must call it from its close handler, or the sessions keep
   * running with nobody listening.
   */
  dispose(): Promise<void>;
}

interface ServerContext {
  peer: Peer;
  sessions: Map<string, Session>;
  /** Wire-level permission requests awaiting a client response. */
  pendingPermissions: Map<string, (decision: PermissionDecision) => void>;
  /** Wire-level question requests awaiting a client response. */
  pendingQuestions: Map<string, (answers: QuestionAnswers) => void>;
  defaultCwd: string;
  defaultPermissionMode: PermissionMode;
  capabilities: InitializeResult["capabilities"];
  initialized: boolean;
}

/** Per-session bookkeeping kept off the session itself (held weakly). */
interface SessionExtras {
  unsubscribe: () => void;
}
const sessionExtras = new WeakMap<Session, SessionExtras>();

function defaultCapabilities(): InitializeResult["capabilities"] {
  return {
    tools: [
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "ls",
      "plan_update",
      "memory_write",
      "task",
      "read_artifact",
      "web_fetch",
    ],
    providers: ["anthropic", "openai", "copilot"],
    modes: [...SUPPORTED_MODES],
  };
}

function attachSessionEvents(ctx: ServerContext, session: Session): SessionExtras {
  let extras = sessionExtras.get(session);
  if (extras) return extras;
  extras = { unsubscribe: () => {} };
  sessionExtras.set(session, extras);
  extras.unsubscribe = session.subscribe((e) => {
    // Fire-and-forget; the peer logs failures itself.
    void ctx.peer
      .notify<EventParams>("event", { sessionId: session.id, event: e })
      .catch(() => {});
    if (e.type === "usage") {
      void ctx.peer
        .notify<UsageParams>("session/usage", {
          sessionId: session.id,
          usage: e.usage,
        })
        .catch(() => {});
    }
  });
  return extras;
}

async function handleInitialize(
  ctx: ServerContext,
  params: InitializeParams,
): Promise<InitializeResult> {
  if (!params || typeof params !== "object") {
    throw new RpcError(ErrorCode.InvalidParams, "initialize params required");
  }
  if (params.protocolVersion !== PROTOCOL_VERSION) {
    throw new RpcError(
      ErrorCode.ProtocolVersionMismatch,
      `Unsupported protocol version: ${params.protocolVersion}`,
      { supported: [PROTOCOL_VERSION] },
    );
  }
  if (params.cwd && typeof params.cwd === "string") {
    ctx.defaultCwd = params.cwd;
  }
  if (params.permissionMode) {
    ctx.defaultPermissionMode = params.permissionMode;
  }
  ctx.initialized = true;
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ctx.capabilities,
  };
}

function assertInitialized(ctx: ServerContext): void {
  if (!ctx.initialized) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      "initialize must be called first",
    );
  }
}

async function loadConfigSafe(cwd: string): Promise<CodepilotConfig | undefined> {
  try {
    return await coreLoadConfig(cwd);
  } catch {
    return undefined;
  }
}

async function handleSessionNew(
  ctx: ServerContext,
  params: SessionNewParams,
): Promise<{ sessionId: string }> {
  assertInitialized(ctx);
  const cwd = params?.cwd ?? ctx.defaultCwd;
  const config = await loadConfigSafe(cwd);
  const effectiveConfig = mergeAgentMode(
    mergePermissionMode(config, ctx.defaultPermissionMode),
    params?.agentMode,
  );
  const session = await createSession({
    cwd,
    config: effectiveConfig,
    model: params?.model ?? config?.model,
    systemPromptExtra: params?.systemPromptExtra,
    agentMode: params?.agentMode ?? effectiveConfig.agentMode,
    onPermissionRequest: (req) => requestPermissionFromClient(ctx, session, req),
    onAskUser: (req) => requestQuestionFromClient(ctx, session, req),
  });
  return registerSession(ctx, session);
}

/**
 * `session/setMode`: switch a session's collaboration mode at runtime.
 * The session emits a `mode` event on its event stream so subscribers
 * observe the change without polling.
 */
async function handleSessionSetMode(
  ctx: ServerContext,
  params: SessionSetModeParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  if (!params?.sessionId) {
    throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  }
  if (!isSupportedMode(params.mode)) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `unsupported mode: ${String(params.mode)}`,
      { supported: SUPPORTED_MODES },
    );
  }
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  await session.setAgentMode(params.mode);
  return {};
}

function isSupportedMode(value: unknown): value is AgentMode {
  return (
    typeof value === "string" &&
    (SUPPORTED_MODES as string[]).includes(value)
  );
}

async function handleSessionResume(
  ctx: ServerContext,
  params: SessionResumeParams,
): Promise<SessionResumeResult> {
  assertInitialized(ctx);
  if (!params?.sessionId) {
    throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  }
  const cwd = ctx.defaultCwd;
  const config = await loadConfigSafe(cwd);
  const effectiveConfig = mergePermissionMode(config, ctx.defaultPermissionMode);
  const session = await createSession({
    cwd,
    config: effectiveConfig,
    sessionId: params.sessionId,
    onPermissionRequest: (req) => requestPermissionFromClient(ctx, session, req),
    onAskUser: (req) => requestQuestionFromClient(ctx, session, req),
  });
  registerSession(ctx, session);
  return { sessionId: session.id, events: session.getEvents() };
}

/** Merge the session-supplied permission mode into config without overwriting other keys. */
function mergePermissionMode(
  config: CodepilotConfig | undefined,
  mode: PermissionMode,
): CodepilotConfig {
  return { ...(config ?? {}), permissionMode: mode };
}

/** Merge a per-call `agentMode` override into the effective config. */
function mergeAgentMode(
  config: CodepilotConfig,
  mode: AgentMode | undefined,
): CodepilotConfig {
  if (!mode) return config;
  return { ...config, agentMode: mode };
}

function registerSession(
  ctx: ServerContext,
  session: Session,
): { sessionId: string } {
  ctx.sessions.set(session.id, session);
  attachSessionEvents(ctx, session);
  return { sessionId: session.id };
}

async function handleSessionList(
  ctx: ServerContext,
): Promise<SessionListResult> {
  assertInitialized(ctx);
  const sessions = await coreListSessions(ctx.defaultCwd);
  return { sessions };
}

const WORKSPACE_MAX_BYTES = 512 * 1024;
function workspacePath(ctx: ServerContext, input: string | undefined): { abs: string; rel: string } {
  const rel = input ?? ".";
  const root = resolve(ctx.defaultCwd);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + "/")) throw new RpcError(ErrorCode.InvalidRequest, "workspace path escapes cwd");
  return { abs, rel: relative(root, abs) || "." };
}

async function handleWorkspaceList(ctx: ServerContext, params: WorkspaceListParams): Promise<WorkspaceListResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path);
  const entries: WorkspaceEntry[] = [];
  for (const name of await readdir(target.abs)) {
    const abs = join(target.abs, name);
    const info = await stat(abs);
    entries.push({ name, path: join(target.rel, name), kind: info.isDirectory() ? "directory" : "file", size: info.isFile() ? info.size : undefined });
  }
  entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
  return { path: target.rel, entries };
}

async function handleWorkspaceRead(ctx: ServerContext, params: WorkspaceReadParams): Promise<WorkspaceReadResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path);
  const data = await readFile(target.abs);
  const truncated = data.byteLength > WORKSPACE_MAX_BYTES;
  const content = data.subarray(0, WORKSPACE_MAX_BYTES).toString("utf8");
  return { path: target.rel, content, size: data.byteLength, hash: createHash("sha256").update(data).digest("hex"), truncated };
}

async function handleWorkspaceSearch(ctx: ServerContext, params: WorkspaceSearchParams): Promise<WorkspaceSearchResult> {
  assertInitialized(ctx);
  const root = workspacePath(ctx, params.path).abs;
  const query = params.query.trim();
  if (!query) return { matches: [], truncated: false };
  const max = Math.min(Math.max(params.maxResults ?? 100, 1), 1000);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let stopped = false;
  async function walk(dir: string): Promise<void> {
    if (stopped) return;
    for (const name of await readdir(dir)) {
      if (name === ".git" || name === "node_modules" || name === ".codepilot") continue;
      const abs = join(dir, name);
      const info = await stat(abs);
      if (info.isDirectory()) await walk(abs);
      else if (info.isFile() && info.size <= WORKSPACE_MAX_BYTES) {
        try {
          const text = await readFile(abs, "utf8");
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.toLowerCase().includes(query.toLowerCase())) {
              matches.push({ path: relative(resolve(ctx.defaultCwd), abs), line: i + 1, text: lines[i]! });
              if (matches.length >= max) { stopped = true; break; }
            }
          }
        } catch { /* binary/unreadable files are skipped */ }
      }
      if (stopped) return;
    }
  }
  await walk(root);
  return { matches, truncated: stopped };
}

async function handleWorkspaceGitStatus(ctx: ServerContext): Promise<WorkspaceGitStatusResult> {
  assertInitialized(ctx);
  try {
    const { stdout } = await execFileAsync("git", ["-C", ctx.defaultCwd, "status", "--short", "--branch", "--porcelain=v1"]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const branch = lines.find(l => l.startsWith("## "))?.slice(3) ?? "(detached/unknown)";
    const files = lines.filter(l => !l.startsWith("## ")).map(l => ({ index: l[0] ?? " ", worktree: l[1] ?? " ", status: l.slice(0, 2), path: l.slice(3) }));
    return { branch, files };
  } catch (err) {
    throw new RpcError(ErrorCode.InvalidRequest, `git status unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleWorkspaceStat(ctx: ServerContext, params: WorkspaceStatParams): Promise<WorkspaceStatResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path);
  try {
    const info = await stat(target.abs);
    if (!info.isFile()) return { path: target.rel, exists: false, size: 0, hash: "" };
    const data = await readFile(target.abs);
    return { path: target.rel, exists: true, size: info.size, hash: createHash("sha256").update(data).digest("hex"), modifiedAt: info.mtimeMs };
  } catch { return { path: target.rel, exists: false, size: 0, hash: "" }; }
}

async function handleWorkspaceGitDiff(ctx: ServerContext, params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult> {
  assertInitialized(ctx);
  const args = ["-C", ctx.defaultCwd, "diff", "--no-ext-diff", "--no-color", "--no-renames"];
  if (params.staged) args.push("--cached");
  if (params.path) args.push("--", workspacePath(ctx, params.path).rel);
  try {
    const { stdout } = await execFileAsync("git", args, { maxBuffer: 1024 * 1024 });
    const bytes = Buffer.from(stdout, "utf8");
    const truncated = bytes.byteLength > WORKSPACE_MAX_BYTES;
    return { path: params.path, diff: bytes.subarray(0, WORKSPACE_MAX_BYTES).toString("utf8"), truncated };
  } catch (err) { throw new RpcError(ErrorCode.InvalidRequest, `git diff unavailable: ${err instanceof Error ? err.message : String(err)}`); }
}

async function handleWorkspaceWrite(ctx: ServerContext, params: WorkspaceWriteParams): Promise<WorkspaceWriteResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path);
  if (Buffer.byteLength(params.content, "utf8") > WORKSPACE_MAX_BYTES) throw new RpcError(ErrorCode.InvalidRequest, "workspace file exceeds 512 KiB");
  const current = await readFile(target.abs).catch(() => Buffer.alloc(0));
  const currentHash = createHash("sha256").update(current).digest("hex");
  if (params.expectedSize !== undefined && current.byteLength !== params.expectedSize) throw new RpcError(ErrorCode.InvalidRequest, "file changed since it was loaded");
  if (params.expectedHash !== undefined && currentHash !== params.expectedHash) throw new RpcError(ErrorCode.InvalidRequest, "file changed since it was loaded");
  const next = Buffer.from(params.content, "utf8");
  const hash = createHash("sha256").update(next).digest("hex");
  const temp = `${target.abs}.codepilot-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, target.abs);
  return { path: target.rel, size: next.byteLength, hash };
}

async function handlePromptSend(
  ctx: ServerContext,
  params: PromptSendParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  // Fire-and-forget: events stream back as `event` notifications.
  void session.prompt(params.text, params.images).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void ctx.peer
      .notify<EventParams>("event", {
        sessionId: session.id,
        event: { type: "error", message, recoverable: false },
      })
      .catch(() => {});
  });
  return {};
}

async function handlePromptCancel(
  ctx: ServerContext,
  params: PromptCancelParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  session.cancel();
  return {};
}

async function handlePermissionRespond(
  ctx: ServerContext,
  params: PermissionRespondParams,
): Promise<Record<string, never>> {
  const resolve = ctx.pendingPermissions.get(params.requestId);
  if (!resolve) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `no pending permission request: ${params.requestId}`,
    );
  }
  ctx.pendingPermissions.delete(params.requestId);
  resolve(params.decision);
  return {};
}

async function handleQuestionRespond(
  ctx: ServerContext,
  params: QuestionRespondParams,
): Promise<Record<string, never>> {
  const resolve = ctx.pendingQuestions.get(params.requestId);
  if (!resolve) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `no pending question request: ${params.requestId}`,
    );
  }
  ctx.pendingQuestions.delete(params.requestId);
  resolve(params.answers ?? {});
  return {};
}

async function handleSessionFork(
  ctx: ServerContext,
  params: SessionForkParams,
): Promise<{ sessionId: string }> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  const forked = await session.fork(params.atEventIndex);
  return registerSession(ctx, forked);
}

/** Drop every session and pending reverse-request this connection owns. */
async function teardown(ctx: ServerContext): Promise<void> {
  const sessions = Array.from(ctx.sessions.values());
  ctx.sessions.clear();
  for (const s of sessions) {
    const extras = sessionExtras.get(s);
    try {
      extras?.unsubscribe();
      await s.dispose();
    } catch {
      /* ignore */
    }
  }
  // Reject outstanding permission requests.
  for (const [, resolve] of ctx.pendingPermissions) resolve("deny");
  ctx.pendingPermissions.clear();
  // Fail-closed for outstanding questions: empty answers (plan_done treats a
  // missing "Approve" answer as not approved, ask_user reports "(no answer)").
  for (const [, resolve] of ctx.pendingQuestions) resolve({});
  ctx.pendingQuestions.clear();
}

async function handleShutdown(
  ctx: ServerContext,
): Promise<Record<string, never>> {
  await teardown(ctx);
  // Tear the peer down after the response is sent.
  setImmediate(() => {
    void ctx.peer.close();
  });
  return {};
}

/**
 * Issue a server-initiated `permission/request` to the client and resolve
 * with the client's `permission/respond` decision.
 *
 * The wire-level requestId is composed as `<sessionId>#<coreId>` to guarantee
 * global uniqueness across concurrent sessions; the client echoes it back
 * unchanged in `permission/respond` and `handlePermissionRespond` matches on
 * that exact string. The returned decision is what core expects
 * (`allow | deny | always`) — the core-level requestId is opaque to the wire.
 */
async function requestPermissionFromClient(
  ctx: ServerContext,
  session: Session,
  req: CorePermissionRequest,
): Promise<PermissionDecision> {
  const wireId = `${session.id}#${req.requestId}`;
  return new Promise<PermissionDecision>((resolve) => {
    ctx.pendingPermissions.set(wireId, resolve);
    void ctx.peer
      .request<PermissionRequestParams, Record<string, never>>(
        "permission/request",
        {
          sessionId: session.id,
          requestId: wireId,
          toolName: req.toolName,
          input: req.input,
          reason: req.reason,
        },
      )
      .catch(() => {
        ctx.pendingPermissions.delete(wireId);
        resolve(defaultDecision(ctx.defaultPermissionMode));
      });
  });
}

function defaultDecision(mode: PermissionMode): PermissionDecision {
  switch (mode) {
    case "yolo":
    case "auto-edit":
      return "allow";
    case "ask":
    default:
      return "deny";
  }
}

/**
 * Issue a server-initiated `question/request` to the client and resolve with
 * the client's `question/respond` answers. Uses the same `<sessionId>#<id>`
 * wire-id convention as permission requests. On transport failure we resolve
 * with empty answers (fail-closed: plan_done reads that as "not approved").
 */
async function requestQuestionFromClient(
  ctx: ServerContext,
  session: Session,
  req: CoreQuestionRequest,
): Promise<QuestionAnswers> {
  const wireId = `${session.id}#${req.requestId}`;
  return new Promise<QuestionAnswers>((resolve) => {
    ctx.pendingQuestions.set(wireId, resolve);
    void ctx.peer
      .request<QuestionRequestParams, Record<string, never>>(
        "question/request",
        {
          sessionId: session.id,
          requestId: wireId,
          questions: req.questions,
        },
      )
      .catch(() => {
        ctx.pendingQuestions.delete(wireId);
        resolve({});
      });
  });
}

/**
 * Convenience: build a peer over `process.stdin/stdout` and wire up handlers.
 */
export async function startServer(
  opts: ServerOptions = {},
): Promise<ServerHandle> {
  const transport = new StdioTransport();
  const peer = new Peer({ transport, debug: false });
  const handle = registerServer(peer, opts);
  // Swallow loop completion — peer lives until stdin closes.
  void handle.peer.loopDone.catch(() => {});
  return handle;
}