/**
 * CodePilot headless protocol server.
 *
 * Bridges `@codepilot/core`'s `Session` API onto a JSON-RPC 2.0 NDJSON
 * transport. One process can serve many sessions; each session is held in a
 * `Map` and its events are forwarded as `event` notifications to the client.
 *
 * Lifecycle:
 * 1. client calls `initialize` (negotiates protocolVersion, exchanges cwd).
 * 2. client opens sessions with `session/new` / `session/resume`.
 * 3. client streams prompts via `prompt/send`; events come back as `event`
 * notifications. The server may issue a `permission/request` reverse
 * request when core's `onPermissionRequest` is invoked; client replies
 * with `permission/respond` and we resolve the pending promise.
 * 4. `shutdown` returns and we close the peer.
 */

import { readdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { homedir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
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
  loadConfigWithSources,
  PROVIDER_TEMPLATES,
  listSelectableModels,
  listRemoteModels,
  redactProviderPreset,
  upsertUserProvider,
  deleteUserProvider,
  setUserActiveEndpoint,
  templateToPreset,
  findProviderIdForFlat,
  type ProviderPreset,
  type ProviderName,
  type ResolvedCodepilotConfig,
} from "@codepilot/core";
import { ErrorCode, Peer, RpcError, StdioTransport } from "./rpc.js";

/** Mirrors the headless protocol's `event` notification params. */
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
 /** Supported collaboration modes (per the headless protocol). */
    modes: AgentMode[];
 /** Config / model management methods available on this server. */
    config?: boolean;
    setModel?: boolean;
  };
}

export interface SessionSetModelParams {
  sessionId: string;
  model: string;
 /** Named provider preset id; when set, switches vendor + model. */
  providerId?: string;
}

export interface ConfigUpsertProviderParams {
  id: string;
  preset: ProviderPreset;
 /** When true, also activate this preset as the user default. */
  setActive?: boolean;
 /** Optional session to sync immediately. */
  sessionId?: string;
}

export interface ConfigDeleteProviderParams {
  id: string;
}

export interface ConfigSetActiveParams {
  providerId: string;
  model?: string;
  sessionId?: string;
 /** Persist as user default (default true). */
  persist?: boolean;
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
/** Native OS folder dialog (server-side). Cancel → path null. */
export interface WorkspacePickFolderResult { path: string | null; supported: boolean; }
/** Browse an absolute directory on the serve host (folder picker UI). */
export interface WorkspaceBrowseParams { path?: string; }
export interface WorkspaceBrowseResult {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string; kind: "file" | "directory" }>;
  roots: Array<{ label: string; path: string }>;
}
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
export interface WorkspaceWatchParams { path?: string; }
export interface WorkspaceWatchResult { watching: boolean; path: string; }
export interface WorkspaceChangedParams {
  path: string;
 /** Debounced change kinds since the last notification. */
  kinds: Array<"rename" | "change">;
 /** Set when the underlying watcher failed; clients should fall back to polling. */
  error?: string;
}

export interface PromptSendParams {
  sessionId: string;
  text: string;
  images?: { mediaType: string; base64: string }[];
 /** Non-image uploads; written under `.codepilot/uploads/` for the model. */
  files?: { name: string; mediaType?: string; base64: string }[];
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
 * mode at runtime.
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

/** Notification (`permission/resolved` / `question/resolved`): another
 * client answered this request — dismiss any prompt still showing it. */
export interface PromptResolvedParams {
  sessionId: string;
  requestId: string;
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
    defaultCwd: opts.defaultCwd ?? process.cwd(),
    defaultPermissionMode: opts.defaultPermissionMode ?? "ask",
    capabilities: opts.capabilities ?? defaultCapabilities(),
    initialized: false,
    sessionSubs: new Map(),
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
  peer.onRequest<SessionSetModelParams, { model: string; providerId?: string }>(
    "session/setModel",
    (p) => handleSessionSetModel(ctx, p),
  );
  peer.onRequest<
    { sessionId: string },
    { model: string; providerId?: string; provider?: string; baseURL?: string }
  >("session/getEndpoint", (p) => handleSessionGetEndpoint(ctx, p));
  peer.onRequest<
    { cwd?: string },
    Awaited<ReturnType<typeof handleConfigGet>>
  >("config/get", (p) => handleConfigGet(ctx, p));
  peer.onRequest<ConfigUpsertProviderParams, { providers: Record<string, ReturnType<typeof redactProviderPreset>> }>(
    "config/upsertProvider",
    (p) => handleConfigUpsertProvider(ctx, p),
  );
  peer.onRequest<ConfigDeleteProviderParams, { providers: Record<string, ReturnType<typeof redactProviderPreset>> }>(
    "config/deleteProvider",
    (p) => handleConfigDeleteProvider(ctx, p),
  );
  peer.onRequest<ConfigSetActiveParams, { model: string; providerId: string }>(
    "config/setActive",
    (p) => handleConfigSetActive(ctx, p),
  );
  peer.onRequest<
    {
      providerId?: string;
      provider?: ProviderName;
      baseURL?: string;
      apiKey?: string;
    },
    { models: string[] }
  >("config/listRemoteModels", (p) => handleConfigListRemoteModels(ctx, p));
  peer.onRequest<SessionResumeParams, SessionResumeResult>(
    "session/resume",
    (p) => handleSessionResume(ctx, p),
  );
  peer.onRequest<{ cwd?: string }, SessionListResult>("session/list", (p) =>
    handleSessionList(ctx, p),
  );
  peer.onRequest<WorkspaceListParams, WorkspaceListResult>("workspace/list", (p) =>
    handleWorkspaceList(ctx, p),
  );
  peer.onRequest<Record<string, never>, WorkspacePickFolderResult>("workspace/pickFolder", () =>
    handleWorkspacePickFolder(),
  );
  peer.onRequest<WorkspaceBrowseParams, WorkspaceBrowseResult>("workspace/browse", (p) =>
    handleWorkspaceBrowse(ctx, p),
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
  peer.onRequest<WorkspaceWatchParams, WorkspaceWatchResult>("workspace/watch", (p) => handleWorkspaceWatch(ctx, p));
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
  defaultCwd: string;
  defaultPermissionMode: PermissionMode;
  capabilities: InitializeResult["capabilities"];
  initialized: boolean;
 /** At most one workspace watcher per connection (re-watch replaces). */
  watcher?: { watcher: FSWatcher; debounce?: ReturnType<typeof setTimeout>; kinds: Set<"rename" | "change">; path: string };
 /** Per-connection event subscriptions, keyed by session id. Each client
 * connection subscribes independently so several clients can follow the
 * same live session at once (and a reconnect re-subscribes cleanly). */
  sessionSubs: Map<string, () => void>;
}

/** Per-session bookkeeping kept off the session itself. */
interface SessionExtras {
  unsubscribe: () => void;
}

/**
 * Process-wide registry of LIVE session instances, shared across every client
 * connection, with a reference count. A session is created once and reused by
 * any connection that opens it (so all clients follow the same running task);
 * it is disposed only when the LAST connection releases it — closing one tab
 * must not kill a task another client (or a background run) still needs.
 */
interface LiveSession {
  session: Session;
 /** Connections currently holding this session (refcount = size). */
  holders: Set<ServerContext>;
 /** Permission / question requests awaiting an answer from ANY holder. */
  prompts: Map<string, PendingPrompt>;
}
const liveSessions = new Map<string, LiveSession>();

/** A reverse request shown on every client following the session; the first
 * answer wins and the others are told to dismiss it. */
type PendingPrompt =
  | { kind: "permission"; params: PermissionRequestParams; settle: (d: PermissionDecision) => void; declined: Set<ServerContext> }
  | { kind: "question"; params: QuestionRequestParams; settle: (a: QuestionAnswers) => void; declined: Set<ServerContext> };

/** Record that `ctx` now holds `session` (idempotent per connection). */
function retainSession(ctx: ServerContext, session: Session): void {
  ctx.sessions.set(session.id, session);
  const live = liveSessions.get(session.id);
  if (live) live.holders.add(ctx);
  else liveSessions.set(session.id, { session, holders: new Set([ctx]), prompts: new Map() });
}

/** Release `sessionId` for this connection; dispose once nobody holds it. */
async function releaseSession(ctx: ServerContext, sessionId: string): Promise<void> {
  if (!ctx.sessions.delete(sessionId)) return; // this connection didn't hold it
  const unsub = ctx.sessionSubs.get(sessionId);
  if (unsub) { try { unsub(); } catch { /* ignore */ } ctx.sessionSubs.delete(sessionId); }
  const live = liveSessions.get(sessionId);
  if (!live) return;
  live.holders.delete(ctx);
  if (live.holders.size === 0) {
 // Nobody left to answer: fail closed so the run can finish.
    for (const p of Array.from(live.prompts.values())) failClosed(live, p, ctx.defaultPermissionMode);
    liveSessions.delete(sessionId);
    try { await live.session.dispose(); } catch { /* ignore */ }
  } else {
 // Another client may still answer; only give up if every remaining
 // holder has already declined.
    for (const p of Array.from(live.prompts.values())) {
      if ([...live.holders].every((h) => p.declined.has(h))) failClosed(live, p, ctx.defaultPermissionMode);
    }
  }
}

function failClosed(live: LiveSession, p: PendingPrompt, mode: PermissionMode): void {
  if (p.kind === "permission") settlePrompt(live, p.params.requestId, defaultDecision(mode), null);
  else settlePrompt(live, p.params.requestId, {}, null);
}

/** Resolve a pending prompt once and tell every other holder to dismiss it. */
function settlePrompt(
  live: LiveSession,
  requestId: string,
  value: PermissionDecision | QuestionAnswers,
  from: ServerContext | null,
): boolean {
  const p = live.prompts.get(requestId);
  if (!p) return false;
  live.prompts.delete(requestId);
  if (p.kind === "permission") p.settle(value as PermissionDecision);
  else p.settle(value as QuestionAnswers);
  const method = p.kind === "permission" ? "permission/resolved" : "question/resolved";
  for (const h of live.holders) {
    if (h === from) continue;
    void h.peer
      .notify<PromptResolvedParams>(method, { sessionId: live.session.id, requestId })
      .catch(() => {});
  }
  return true;
}

/** Send a pending prompt to one holder. Clients answer either inline (the
 * reverse request's result carries `decision` / `answers`, as the CLI
 * does) or later via `permission/respond` / `question/respond` (web). */
function sendPrompt(live: LiveSession, p: PendingPrompt, holder: ServerContext): void {
  const method = p.kind === "permission" ? "permission/request" : "question/request";
  void holder.peer
    .request<typeof p.params, { decision?: PermissionDecision; answers?: QuestionAnswers } | undefined>(method, p.params)
    .then((res) => {
      if (p.kind === "permission" && res?.decision) settlePrompt(live, p.params.requestId, res.decision, holder);
      else if (p.kind === "question" && res?.answers) settlePrompt(live, p.params.requestId, res.answers, holder);
    })
    .catch(() => {
      p.declined.add(holder);
      if (live.prompts.has(p.params.requestId) && [...live.holders].every((h) => p.declined.has(h))) {
        failClosed(live, p, holder.defaultPermissionMode);
      }
    });
}

/** Replay still-pending prompts to a connection that just attached. */
function replayPrompts(ctx: ServerContext, sessionId: string): void {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  for (const p of live.prompts.values()) sendPrompt(live, p, ctx);
}

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
    config: true,
    setModel: true,
  };
}

function attachSessionEvents(ctx: ServerContext, session: Session): SessionExtras {
 // Subscribe THIS connection to the session's event stream. Keyed per-ctx
 // (not globally) so multiple clients can follow the same live session and a
 // reconnect re-subscribes without clobbering another connection's stream.
  const prev = ctx.sessionSubs.get(session.id);
  if (prev) return { unsubscribe: prev };
 // `subscribe` replays the history synchronously before returning. Clients
 // get that history in the `session/new` / `session/resume` result, so only
 // stream what happens from now on — replaying it here as well delivered
 // every earlier event twice.
  let replaying = true;
  const unsubscribe = session.subscribe((e) => {
    if (replaying) return;
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
  replaying = false;
  ctx.sessionSubs.set(session.id, unsubscribe);
  return { unsubscribe };
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
 * `session/setModel`: switch model (and optionally provider preset) at runtime.
 */
async function handleSessionSetModel(
  ctx: ServerContext,
  params: SessionSetModelParams,
): Promise<{ model: string; providerId?: string }> {
  assertInitialized(ctx);
  if (!params?.sessionId || !params.model) {
    throw new RpcError(ErrorCode.InvalidParams, "sessionId and model required");
  }
  const session = requireSession(ctx, params.sessionId);
 // Settings may have added providers after this session was created — refresh
 // the preset map from disk so cross-provider picks don't fail.
  if (params.providerId) {
    try {
      const loaded = await loadConfigWithSources(ctx.defaultCwd);
      if (loaded.config.providers) {
        session.mergeProviders(loaded.config.providers);
      }
    } catch {
 /* best-effort */
    }
  }
  if (params.providerId) {
    await session.setEndpoint({
      model: params.model,
      providerId: params.providerId,
    });
  } else {
    await session.setModel(params.model);
  }
  return {
    model: session.getModel(),
    providerId: session.getProviderId(),
  };
}

async function handleSessionGetEndpoint(
  ctx: ServerContext,
  params: { sessionId: string },
): Promise<{
  model: string;
  providerId?: string;
  provider?: string;
  baseURL?: string;
}> {
  assertInitialized(ctx);
  if (!params?.sessionId) {
    throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  }
  const session = requireSession(ctx, params.sessionId);
  const cfg = session.getConfig();
  return {
    model: session.getModel(),
    providerId: session.getProviderId(),
    provider: cfg.provider,
    baseURL: cfg.baseURL,
  };
}

async function handleConfigGet(
  ctx: ServerContext,
  params: { cwd?: string } = {},
): Promise<{
  active: {
    provider?: string;
    model?: string;
    smallModel?: string;
    baseURL?: string;
    providerId?: string;
    hasApiKey: boolean;
    apiKeyHint?: string;
  };
  providers: Record<string, ReturnType<typeof redactProviderPreset>>;
  selectableModels: ReturnType<typeof listSelectableModels>;
  templates: typeof PROVIDER_TEMPLATES;
}> {
  assertInitialized(ctx);
  const cwd = params?.cwd ?? ctx.defaultCwd;
  let config: ResolvedCodepilotConfig;
  try {
    const loaded = await loadConfigWithSources(cwd);
    config = loaded.config;
  } catch {
    config = (await loadConfigSafe(cwd)) as ResolvedCodepilotConfig ?? {};
  }
  const providers: Record<string, ReturnType<typeof redactProviderPreset>> = {};
  for (const [id, preset] of Object.entries(config.providers ?? {})) {
    providers[id] = redactProviderPreset(preset);
  }
  const { hasApiKey, apiKeyHint } = (() => {
    const key = config.apiKey;
    if (!key) return { hasApiKey: false as const };
    return {
      hasApiKey: true as const,
      apiKeyHint: key.length <= 4 ? "****" : key.slice(-4),
    };
  })();
  return {
    active: {
      provider: config.provider,
      model: config.model,
      smallModel: config.smallModel,
      baseURL: config.baseURL,
      providerId: findProviderIdForFlat(config),
      hasApiKey,
      apiKeyHint,
    },
    providers,
    selectableModels: listSelectableModels(config),
    templates: [...PROVIDER_TEMPLATES],
  };
}

async function handleConfigUpsertProvider(
  ctx: ServerContext,
  params: ConfigUpsertProviderParams,
): Promise<{ providers: Record<string, ReturnType<typeof redactProviderPreset>> }> {
  assertInitialized(ctx);
  if (!params?.id || !params.preset?.provider) {
    throw new RpcError(ErrorCode.InvalidParams, "id and preset.provider required");
  }
 // Preserve existing apiKey when the client sends an empty placeholder.
  const cwd = ctx.defaultCwd;
  let existingKey: string | undefined;
  try {
    const loaded = await loadConfigWithSources(cwd);
    existingKey = loaded.config.providers?.[params.id]?.apiKey;
  } catch {
 /* ignore */
  }
  const preset: ProviderPreset = { ...params.preset };
  if ((!preset.apiKey || preset.apiKey === "") && existingKey) {
    preset.apiKey = existingKey;
  }
  const providers = await upsertUserProvider(params.id, preset);
  if (params.setActive) {
    await setUserActiveEndpoint({
      providerId: params.id,
      provider: preset.provider,
      model: preset.model,
      smallModel: preset.smallModel,
      baseURL: preset.baseURL,
      apiKey: preset.apiKey,
    });
    if (params.sessionId) {
      const session = ctx.sessions.get(params.sessionId);
      if (session) {
        await session.setEndpoint({
          providerId: params.id,
          model: preset.model ?? session.getModel(),
        });
      }
    }
  }
  const redacted: Record<string, ReturnType<typeof redactProviderPreset>> = {};
  for (const [id, p] of Object.entries(providers)) {
    redacted[id] = redactProviderPreset(p);
  }
  return { providers: redacted };
}

async function handleConfigDeleteProvider(
  ctx: ServerContext,
  params: ConfigDeleteProviderParams,
): Promise<{ providers: Record<string, ReturnType<typeof redactProviderPreset>> }> {
  assertInitialized(ctx);
  if (!params?.id) {
    throw new RpcError(ErrorCode.InvalidParams, "id required");
  }
  const providers = await deleteUserProvider(params.id);
  const redacted: Record<string, ReturnType<typeof redactProviderPreset>> = {};
  for (const [id, p] of Object.entries(providers)) {
    redacted[id] = redactProviderPreset(p);
  }
  return { providers: redacted };
}

async function handleConfigListRemoteModels(
  ctx: ServerContext,
  params: {
    providerId?: string;
    provider?: ProviderName;
    baseURL?: string;
    apiKey?: string;
  } = {},
): Promise<{ models: string[] }> {
  assertInitialized(ctx);
  let provider: ProviderName = params.provider ?? "openai";
  let baseURL = params.baseURL;
  let apiKey = params.apiKey;
  if (params.providerId) {
    const tmpl = PROVIDER_TEMPLATES.find((t) => t.id === params.providerId);
    if (tmpl) {
      provider = tmpl.provider;
      baseURL = baseURL || tmpl.baseURL;
    }
    try {
      const loaded = await loadConfigWithSources(ctx.defaultCwd);
      const saved = loaded.config.providers?.[params.providerId];
      if (saved) {
        provider = saved.provider ?? provider;
        baseURL = baseURL || saved.baseURL;
        if (!apiKey) apiKey = saved.apiKey;
      }
    } catch {
 /* ignore */
    }
  }
  if (provider === "openai" && !baseURL) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      "baseURL required to list models for OpenAI-compatible providers",
    );
  }
  try {
    const models = await listRemoteModels({ provider, baseURL, apiKey });
    return { models };
  } catch (err) {
    throw new RpcError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function handleConfigSetActive(
  ctx: ServerContext,
  params: ConfigSetActiveParams,
): Promise<{ model: string; providerId: string }> {
  assertInitialized(ctx);
  if (!params?.providerId) {
    throw new RpcError(ErrorCode.InvalidParams, "providerId required");
  }
  const cwd = ctx.defaultCwd;
  let preset: ProviderPreset | undefined;
  try {
    const loaded = await loadConfigWithSources(cwd);
    preset = loaded.config.providers?.[params.providerId];
  } catch {
 /* ignore */
  }
  if (!preset) {
 // Allow activating a freshly-templated id that isn't saved yet by
 // looking up built-in templates.
    const tmpl = PROVIDER_TEMPLATES.find((t) => t.id === params.providerId);
    if (tmpl) {
      preset = templateToPreset(tmpl);
      await upsertUserProvider(params.providerId, preset);
    }
  }
  if (!preset) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `unknown provider preset: ${params.providerId}`,
    );
  }
  const model = params.model ?? preset.model ?? "gpt-4o-mini";
  if (params.persist !== false) {
    await setUserActiveEndpoint({
      providerId: params.providerId,
      provider: preset.provider as ProviderName,
      model,
      smallModel: preset.smallModel,
      baseURL: preset.baseURL,
      apiKey: preset.apiKey,
    });
  }
  if (params.sessionId) {
    const session = requireSession(ctx, params.sessionId);
    await session.setEndpoint({ providerId: params.providerId, model });
    return { model: session.getModel(), providerId: params.providerId };
  }
  return { model, providerId: params.providerId };
}

function requireSession(ctx: ServerContext, sessionId: string): Session {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    throw new RpcError(ErrorCode.SessionNotFound, `unknown session: ${sessionId}`);
  }
  return session;
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
 // If this session is ALREADY live in memory (running in the background, or
 // open on another connection), reuse that instance. Creating a fresh one
 // from the on-disk JSONL would hand back a frozen snapshot and subscribe the
 // client to a dead copy. We look at the PROCESS-WIDE live registry, not just
 // this connection's, so a task started elsewhere is followed live.
  const existing = liveSessions.get(params.sessionId)?.session
    ?? ctx.sessions.get(params.sessionId);
  if (existing) {
    retainSession(ctx, existing);
    attachSessionEvents(ctx, existing);
 // After the resume response, so the client has the session open first.
    setImmediate(() => replayPrompts(ctx, existing.id));
    return { sessionId: existing.id, events: existing.getHistory() };
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
  return { sessionId: session.id, events: session.getHistory() };
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
  retainSession(ctx, session);
  attachSessionEvents(ctx, session);
  return { sessionId: session.id };
}

async function handleSessionList(
  ctx: ServerContext,
  params?: { cwd?: string },
): Promise<SessionListResult> {
  assertInitialized(ctx);
 // Optional cwd filters; omit to return every session (web multi-workspace).
  const sessions = await coreListSessions(
    params && typeof params.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : undefined,
  );
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

/** Open a native folder chooser on the machine running `codepilot serve`. */
async function handleWorkspacePickFolder(): Promise<WorkspacePickFolderResult> {
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

async function handleWorkspaceBrowse(
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
  const target = workspacePath(ctx, params.path);
  const root = target.abs;
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new RpcError(ErrorCode.InvalidRequest, `workspace search path is not a directory: ${target.rel}`);
  const query = params.query.trim();
  if (!query) return { matches: [], truncated: false };
  const max = Math.min(Math.max(params.maxResults ?? 100, 1), 1000);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let stopped = false;
  async function walk(dir: string): Promise<void> {
    if (stopped) return;
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      if (name === ".git" || name === "node_modules" || name === ".codepilot") continue;
      const abs = join(dir, name);
      let info;
      try { info = await stat(abs); } catch { continue; }
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

const WATCH_DEBOUNCE_MS = 150;
function stopWatcher(ctx: ServerContext): void {
  const w = ctx.watcher;
  if (!w) return;
  ctx.watcher = undefined;
  if (w.debounce) clearTimeout(w.debounce);
  try { w.watcher.close(); } catch { /* already closed */ }
}

async function handleWorkspaceWatch(ctx: ServerContext, params: WorkspaceWatchParams): Promise<WorkspaceWatchResult> {
  assertInitialized(ctx);
  stopWatcher(ctx);
  const target = workspacePath(ctx, params.path);
  const info = await stat(target.abs).catch(() => null);
  if (!info?.isDirectory()) throw new RpcError(ErrorCode.InvalidRequest, `workspace watch path is not a directory: ${target.rel}`);
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
        void ctx.peer.notify<WorkspaceChangedParams>("workspace/changed", { path: entry.path, kinds }).catch(() => {});
      }, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    throw new RpcError(ErrorCode.InvalidRequest, `workspace watch unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = { watcher, kinds: new Set<"rename" | "change">(), path: target.rel };
  ctx.watcher = entry;
  watcher.on("error", (err) => {
 // A broken watcher must not silently stop notifying: tell the client to
 // fall back to polling, then drop the watcher.
    if (ctx.watcher === entry) stopWatcher(ctx);
    void ctx.peer.notify<WorkspaceChangedParams>("workspace/changed", {
      path: target.rel, kinds: [], error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  });
  return { watching: true, path: target.rel };
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
  void session.prompt(params.text, params.images, params.files).catch((err: unknown) => {
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

/** Wire request ids are `<sessionId>#<coreId>`. */
function liveForRequest(requestId: string): LiveSession | undefined {
  const hash = requestId.indexOf("#");
  return hash > 0 ? liveSessions.get(requestId.slice(0, hash)) : undefined;
}

async function handlePermissionRespond(
  ctx: ServerContext,
  params: PermissionRespondParams,
): Promise<Record<string, never>> {
  const live = liveForRequest(params.requestId);
  if (!live || !settlePrompt(live, params.requestId, params.decision, ctx)) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `no pending permission request: ${params.requestId}`,
    );
  }
  return {};
}

async function handleQuestionRespond(
  ctx: ServerContext,
  params: QuestionRespondParams,
): Promise<Record<string, never>> {
  const live = liveForRequest(params.requestId);
  if (!live || !settlePrompt(live, params.requestId, params.answers ?? {}, ctx)) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `no pending question request: ${params.requestId}`,
    );
  }
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

/** Release every session and pending reverse-request this connection owns. */
async function teardown(ctx: ServerContext): Promise<void> {
  stopWatcher(ctx);
 // Release each held session via the shared refcount — dispose happens only
 // when the LAST connection lets go, so closing one client never kills a task
 // another client (or a background run) is still using.
 // Pending prompts fail closed inside releaseSession once no other client
 // following the session is left to answer them.
  for (const id of Array.from(ctx.sessions.keys())) {
    await releaseSession(ctx, id);
  }
  ctx.sessionSubs.clear();
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
  const live = liveFor(ctx, session);
  const params: PermissionRequestParams = {
    sessionId: session.id,
    requestId: `${session.id}#${req.requestId}`,
    toolName: req.toolName,
    input: req.input,
    reason: req.reason,
  };
  return new Promise<PermissionDecision>((settle) => {
    const p: PendingPrompt = { kind: "permission", params, settle, declined: new Set() };
    live.prompts.set(params.requestId, p);
    for (const h of live.holders) sendPrompt(live, p, h);
  });
}

/** The shared live entry for `session`, or a private one for a session that
 * is not (or no longer) registered — then only `ctx` is asked. */
function liveFor(ctx: ServerContext, session: Session): LiveSession {
  return liveSessions.get(session.id) ?? { session, holders: new Set([ctx]), prompts: new Map() };
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
  const live = liveFor(ctx, session);
  const params: QuestionRequestParams = {
    sessionId: session.id,
    requestId: `${session.id}#${req.requestId}`,
    questions: req.questions,
  };
  return new Promise<QuestionAnswers>((settle) => {
    const p: PendingPrompt = { kind: "question", params, settle, declined: new Set() };
    live.prompts.set(params.requestId, p);
    for (const h of live.holders) sendPrompt(live, p, h);
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