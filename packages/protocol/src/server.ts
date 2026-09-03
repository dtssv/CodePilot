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

import type {
  CodepilotConfig,
  Event,
  PermissionDecision,
  PermissionMode,
  PermissionRequest as CorePermissionRequest,
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
  capabilities: { tools: string[]; providers: string[] };
}

export interface SessionNewParams {
  cwd?: string;
  model?: string;
  systemPromptExtra?: string;
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

export interface SessionForkParams {
  sessionId: string;
  atEventIndex?: number;
}

/** Wire params for the reverse request we send to the client. */
export interface PermissionRequestParams {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
}

export const PROTOCOL_VERSION = 1;

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
  peer.onRequest<SessionResumeParams, SessionResumeResult>(
    "session/resume",
    (p) => handleSessionResume(ctx, p),
  );
  peer.onRequest<{}, SessionListResult>("session/list", () =>
    handleSessionList(ctx),
  );
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
}

interface ServerContext {
  peer: Peer;
  sessions: Map<string, Session>;
  /** Wire-level permission requests awaiting a client response. */
  pendingPermissions: Map<string, (decision: PermissionDecision) => void>;
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
  const effectiveConfig = mergePermissionMode(config, ctx.defaultPermissionMode);
  const session = await createSession({
    cwd,
    config: effectiveConfig,
    model: params?.model ?? config?.model,
    systemPromptExtra: params?.systemPromptExtra,
    onPermissionRequest: (req) => requestPermissionFromClient(ctx, session, req),
  });
  return registerSession(ctx, session);
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

async function handleShutdown(
  ctx: ServerContext,
): Promise<Record<string, never>> {
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