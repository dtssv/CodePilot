import type {
  AgentMode,
  CodepilotConfig,
  DiagnosticsProvider,
  Event,
  PermissionMode,
  PermissionPresetName,
  Session,
} from "@codepilot/core";
import {
  createSession,
  SessionLockedError,
  liveSessionLockOwner,
  listSessions as coreListSessions,
  setSessionPinned as coreSetSessionPinned,
  setSessionArchived as coreSetSessionArchived,
  loadCwdFromDisk,
  normalizeCwd,
  loadConfigWithSources,
  exportSession,
  describeHooks,
  formatHooks,
  describeAgents,
  formatAgents,
  PERMISSION_PRESETS,
  type RichSessionSummary,
} from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import {
  assertCwdInGrantScope,
  assertInitialized,
  grantAllowedCwds,
  requireSession,
  type ServerContext,
} from "../context.js";
import { loadConfigSafe } from "../loadConfigSafe.js";
import {
  liveForRequest,
  liveSessions,
  queueSessionGoal,
  recordPendingGoal,
  registerSession,
  replayPrompts,
  requestPermissionFromClient,
  requestQuestionFromClient,
  settlePrompt,
  toResolution,
} from "../liveSessions.js";
import { makeMcpOpenAuthUrl } from "../mcpOpenAuth.js";
import { SUPPORTED_MODES } from "../../server.js";
import {
  DEFAULT_RESUME_HISTORY_LIMIT,
  type DiagnosticsRequestParams,
  type DiagnosticsRequestResult,
  type EventParams,
  type PermissionRuleEffect,
  type PermissionRuleScope,
  type PermissionsAddResult,
  type PermissionsEditParams,
  type PermissionsListParams,
  type PermissionsListResult,
  type PermissionsRemoveResult,
  type PermissionRespondParams,
  type QuestionRespondParams,
  type SessionForkParams,
  type SessionHistoryParams,
  type SessionHistoryResult,
  type SessionListResult,
  type SessionNewParams,
  type SessionResumeParams,
  type SessionResumeResult,
  type SessionSetModeParams,
  type SessionSetModelParams,
} from "../wireTypes.js";

function makeDiagnosticsProvider(ctx: ServerContext, getSession: () => Session): DiagnosticsProvider {
  const ask = (path?: string): Promise<DiagnosticsRequestResult> => {
    const params: DiagnosticsRequestParams = {
      sessionId: getSession().id,
      ...(path ? { path } : {}),
    };
    return ctx.peer
      .request<DiagnosticsRequestParams, DiagnosticsRequestResult>("diagnostics/request", params)
      .catch(() => ({ unavailable: true }) as DiagnosticsRequestResult);
  };
  return {
    async forFile(path) {
      const res = await ask(path);
      return res.unavailable ? null : (res.diagnostics ?? []);
    },
    async forWorkspace() {
      const res = await ask();
      return res.unavailable ? null : (res.files ?? []);
    },
  };
}

export async function handleSessionUndo(
  ctx: ServerContext,
  params: { sessionId: string },
): Promise<{ restored: string[]; deleted: string[]; label: string }> {
  assertInitialized(ctx);
  const live = liveSessions.get(params.sessionId);
  if (!live) throw new RpcError(ErrorCode.InvalidParams, "session not found");
  if (typeof live.session.undo !== "function") {
    throw new RpcError(ErrorCode.InvalidRequest, "undo not supported");
  }
  return live.session.undo();
}

export function liveSessionOrThrow(ctx: ServerContext, sessionId: string): Session {
  assertInitialized(ctx);
  const live = liveSessions.get(sessionId);
  if (!live) throw new RpcError(ErrorCode.InvalidParams, "session not found");
  return live.session;
}

export async function handleSessionRedo(
  ctx: ServerContext,
  params: { sessionId: string },
): Promise<{ restored: string[]; deleted: string[]; label: string }> {
  assertInitialized(ctx);
  const live = liveSessions.get(params.sessionId);
  if (!live) throw new RpcError(ErrorCode.InvalidParams, "session not found");
  if (typeof live.session.redo !== "function") {
    throw new RpcError(ErrorCode.InvalidRequest, "redo not supported");
  }
  return live.session.redo();
}

const PERMISSION_MODES = new Set<PermissionMode>([
  "ask",
  "auto-edit",
  "yolo",
  "auto",
  "dont-ask",
]);

export function handleSessionSetPermissionMode(
  ctx: ServerContext,
  params: { sessionId: string; mode: PermissionMode },
): { mode: PermissionMode } {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  if (!PERMISSION_MODES.has(params.mode)) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `mode must be one of: ${[...PERMISSION_MODES].join(", ")}`,
    );
  }
  const session = liveSessionOrThrow(ctx, params.sessionId);
  return { mode: session.setPermissionMode(params.mode) };
}

export function handleSessionSetPreset(
  ctx: ServerContext,
  params: { sessionId: string; preset: PermissionPresetName },
): {
  preset: PermissionPresetName;
  permissionMode: PermissionMode;
  sandbox: { mode: string; unavailable?: boolean; backend?: string };
} {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  if (!(params.preset in PERMISSION_PRESETS)) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `preset must be one of: ${Object.keys(PERMISSION_PRESETS).join(", ")}`,
    );
  }
  const session = liveSessionOrThrow(ctx, params.sessionId);
  const out = session.setPreset(params.preset);
  return {
    preset: out.preset,
    permissionMode: out.permissionMode,
    sandbox: {
      mode: out.sandbox.mode,
      unavailable: out.sandbox.unavailable,
      backend: out.sandbox.backend,
    },
  };
}

export async function handleSessionExport(
  ctx: ServerContext,
  params: { sessionId: string; format?: "markdown" | "jsonl" },
): Promise<{ format: "markdown" | "jsonl"; body: string; suggestedName: string }> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  await assertSessionInGrantScope(ctx, params.sessionId);
  const format = params.format === "jsonl" ? "jsonl" : "markdown";
  const body = await exportSession(params.sessionId, format);
  const ext = format === "jsonl" ? "jsonl" : "md";
  return {
    format,
    body,
    suggestedName: `codepilot-session-${params.sessionId}.${ext}`,
  };
}

export function handleSessionGoal(
  ctx: ServerContext,
  params: { sessionId: string; objective: string; maxRounds?: number },
): { accepted: true; running: boolean } {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  const objective = typeof params.objective === "string" ? params.objective.trim() : "";
  if (!objective) throw new RpcError(ErrorCode.InvalidParams, "objective required");
  const session = liveSessionOrThrow(ctx, params.sessionId);
  return queueSessionGoal(ctx, session, {
    objective,
    ...(typeof params.maxRounds === "number" ? { maxRounds: params.maxRounds } : {}),
  });
}

export function handleSessionDescribeHooks(
  ctx: ServerContext,
  params: { sessionId: string },
): { text: string } {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  const session = liveSessionOrThrow(ctx, params.sessionId);
  return { text: formatHooks(describeHooks(session.getHookEngine())) };
}

export async function handleSessionDescribeAgents(
  ctx: ServerContext,
  params: { sessionId?: string; cwd?: string },
): Promise<{ text: string }> {
  assertInitialized(ctx);
  let cwd = params?.cwd;
  if (!cwd && params?.sessionId) {
    cwd = liveSessionOrThrow(ctx, params.sessionId).getCwd();
  }
  if (!cwd) cwd = ctx.defaultCwd;
  return { text: formatAgents(await describeAgents(cwd)) };
}

export async function handleSessionNew(
  ctx: ServerContext,
  params: SessionNewParams,
): Promise<{ sessionId: string }> {
  assertInitialized(ctx);
  const cwd = params?.cwd ?? ctx.defaultCwd;
  // A remote grant may only create a session in an authorized workspace.
  assertCwdInGrantScope(ctx, params?.cwd);
  const config = await loadConfigSafe(cwd);
  const effectiveConfig = mergeAgentMode(
    mergePermissionMode(config, ctx.defaultPermissionMode),
    params?.agentMode,
  );
  const session = await createSession({
    cwd,
    config: effectiveConfig,
    // Only pin when the client passes a model: a `config.model` fallback here
    // bypasses createSession's sticky resolution, so "New session" would snap
    // back to the configured default instead of the model just used.
    ...(params?.model ? { model: params.model } : {}),
    systemPromptExtra: params?.systemPromptExtra,
    agentMode: params?.agentMode ?? effectiveConfig.agentMode,
    ...(ctx.lockIdentity ? { lockIdentity: ctx.lockIdentity } : {}),
    onPermissionRequest: (req) => requestPermissionFromClient(ctx, session, req),
    onAskUser: (req) => requestQuestionFromClient(ctx, session, req),
    onGoalRequest: (req) => recordPendingGoal(ctx, session.id, req),
    onMcpOpenAuthUrl: makeMcpOpenAuthUrl(ctx),
    diagnosticsProvider: makeDiagnosticsProvider(ctx, () => session),
  });
  return registerSession(ctx, session);
}

/**
 * `session/setModel`: switch model (and optionally provider preset) at runtime.
 */
export async function handleSessionSetModel(
  ctx: ServerContext,
  params: SessionSetModelParams,
): Promise<{
  model: string;
  providerId?: string;
  reasoningEffort?: "low" | "medium" | "high";
}> {
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
  if (params.reasoningEffort !== undefined) {
    session.setReasoningEffort(
      params.reasoningEffort === null ? undefined : params.reasoningEffort,
    );
  }
  return {
    model: session.getModel(),
    providerId: session.getProviderId(),
    reasoningEffort: session.getReasoningEffort(),
  };
}

export async function handleSessionGetEndpoint(
  ctx: ServerContext,
  params: { sessionId: string },
): Promise<{
  model: string;
  providerId?: string;
  provider?: string;
  baseURL?: string;
  reasoningEffort?: "low" | "medium" | "high";
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
    reasoningEffort: session.getReasoningEffort(),
  };
}

/**
 * `session/setMode`: switch a session's collaboration mode at runtime.
 * The session emits a `mode` event on its event stream so subscribers
 * observe the change without polling.
 */
export async function handleSessionSetMode(
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

function assertRuleEffect(effect: unknown): PermissionRuleEffect {
  if (effect === "allow" || effect === "ask" || effect === "deny") return effect;
  throw new RpcError(ErrorCode.InvalidParams, `invalid effect: ${String(effect)}`);
}

/** `permissions/list`: persisted rules for a scope (repo default). */
export async function handlePermissionsList(
  ctx: ServerContext,
  params: PermissionsListParams,
): Promise<PermissionsListResult> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  const session = requireSession(ctx, params.sessionId);
  const scope: PermissionRuleScope = params.scope === "user" ? "user" : "repo";
  const rules = await session.listSavedPermissionRules(scope);
  return { scope, allow: rules.allow, ask: rules.ask, deny: rules.deny };
}

/** `permissions/add`: persist a rule and hot-apply it to the live session. */
export async function handlePermissionsAdd(
  ctx: ServerContext,
  params: PermissionsEditParams,
): Promise<PermissionsAddResult> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  const session = requireSession(ctx, params.sessionId);
  const effect = assertRuleEffect(params.effect);
  const rule = (params.rule ?? "").trim();
  if (!rule) throw new RpcError(ErrorCode.InvalidParams, "rule required");
  const scope: PermissionRuleScope = params.scope === "user" ? "user" : "repo";
  const path = await session.addSavedPermissionRule(rule, effect, scope);
  return { path };
}

/** `permissions/remove`: delete a persisted rule and hot-apply the removal. */
export async function handlePermissionsRemove(
  ctx: ServerContext,
  params: PermissionsEditParams,
): Promise<PermissionsRemoveResult> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  const session = requireSession(ctx, params.sessionId);
  const effect = assertRuleEffect(params.effect);
  const rule = (params.rule ?? "").trim();
  if (!rule) throw new RpcError(ErrorCode.InvalidParams, "rule required");
  const scope: PermissionRuleScope = params.scope === "user" ? "user" : "repo";
  const removed = await session.removeSavedPermissionRule(rule, effect, scope);
  return { removed };
}

/**
 * Slice a recent tail of the display history for fast resume. Prefer starting
 * at a user-message boundary so the first painted turn is coherent. `limit`
 * 0 / negative → full history.
 */
export function sliceHistoryTail(
  events: Event[],
  limit: number = DEFAULT_RESUME_HISTORY_LIMIT,
): { events: Event[]; historyTruncated: boolean; historyBefore?: number } {
  if (!Number.isFinite(limit) || limit <= 0 || events.length <= limit) {
    return { events, historyTruncated: false };
  }
  let start = events.length - limit;
  for (let i = start; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "user") {
      start = i;
      break;
    }
  }
  if (start <= 0) return { events, historyTruncated: false };
  return {
    events: events.slice(start),
    historyTruncated: true,
    historyBefore: start,
  };
}

/** Older page ending at `before` (exclusive), same boundary preference. */
export function sliceHistoryBefore(
  events: Event[],
  before: number,
  limit: number = DEFAULT_RESUME_HISTORY_LIMIT,
): SessionHistoryResult {
  const end = Math.max(0, Math.min(Math.floor(before), events.length));
  if (end === 0) return { events: [], historyTruncated: false };
  const cap = !Number.isFinite(limit) || limit <= 0 ? end : Math.floor(limit);
  let start = Math.max(0, end - cap);
  for (let i = start; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "user") {
      start = i;
      break;
    }
  }
  return {
    events: events.slice(start, end),
    historyTruncated: start > 0,
    ...(start > 0 ? { historyBefore: start } : {}),
  };
}

async function enrichLockedOwner(
  owner: SessionLockedError["owner"],
): Promise<SessionLockedError["owner"]> {
  if (owner.url) return owner;
  try {
    const { readLiveServeInfo } = await import("../../serve-info.js");
    const live = await readLiveServeInfo();
    if (live && live.pid === owner.pid) {
      return {
        ...owner,
        url: live.url,
        ...(live.token ? { token: live.token } : {}),
      };
    }
  } catch {
    /* best-effort */
  }
  return owner;
}

function resumeHistoryPayload(
  session: Session,
  params: SessionResumeParams,
  extra: { readOnly?: boolean } = {},
): SessionResumeResult {
  const full = session.getHistory();
  const limit =
    params.historyLimit === undefined ? DEFAULT_RESUME_HISTORY_LIMIT : params.historyLimit;
  const sliced = sliceHistoryTail(full, limit);
  return {
    sessionId: session.id,
    events: sliced.events,
    ...(sliced.historyTruncated
      ? { historyTruncated: true, historyBefore: sliced.historyBefore }
      : {}),
    ...(extra.readOnly ? { readOnly: true } : {}),
  };
}

export async function handleSessionResume(
  ctx: ServerContext,
  params: SessionResumeParams,
): Promise<SessionResumeResult> {
  assertInitialized(ctx);
  if (!params?.sessionId) {
    throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  }
  // A scoped QR remote grant may only resume sessions in its granted
  // workspaces — otherwise hiding a session from session/list is cosmetic: a
  // phone could still resume any id and read its full history. Resolve the
  // session's cwd from disk and reject out-of-scope ids. The local connection
  // (no grant) is unaffected.
  await assertSessionInGrantScope(ctx, params.sessionId);
 // Reuse a process-wide live instance if present — creating a fresh one from
 // disk would hand back a frozen snapshot. We look at the PROCESS-WIDE
 // registry, not just this connection's.
  const existing = liveSessions.get(params.sessionId)?.session
    ?? ctx.sessions.get(params.sessionId);
  if (existing) {
    registerSession(ctx, existing);
 // After the resume response, so the client has the session open first.
    setImmediate(() => {
      replayPrompts(ctx, existing.id);
      forwardInterruptedRecovery(ctx, existing);
    });
    return resumeHistoryPayload(existing, params);
  }
  const cwd = ctx.defaultCwd;
  const config = await loadConfigSafe(cwd);
  const effectiveConfig = mergePermissionMode(config, ctx.defaultPermissionMode);
  let session: Session;
  try {
    session = await createSession({
      cwd,
      config: effectiveConfig,
      sessionId: params.sessionId,
      ...(params.readOnly ? { readOnly: true } : {}),
      ...(ctx.lockIdentity ? { lockIdentity: ctx.lockIdentity } : {}),
      onPermissionRequest: (req) => requestPermissionFromClient(ctx, session, req),
      onAskUser: (req) => requestQuestionFromClient(ctx, session, req),
      onGoalRequest: (req) => recordPendingGoal(ctx, session.id, req),
      onMcpOpenAuthUrl: makeMcpOpenAuthUrl(ctx),
      diagnosticsProvider: makeDiagnosticsProvider(ctx, () => session),
    });
  } catch (err) {
    // Another live process holds the write lease. Surface the owner's attach
    // info so the client can attach to the holding daemon as a subscriber or
    // re-open read-only (session/resume with readOnly:true). Enrich a lock
    // missing url/token from live serve.json when the pid matches.
    if (err instanceof SessionLockedError) {
      const owner = await enrichLockedOwner(err.owner);
      throw new RpcError(
        ErrorCode.SessionLocked,
        owner.url
          ? `session ${err.sessionId} is owned by pid ${owner.pid} (daemon ${owner.url})`
          : err.message,
        { sessionId: err.sessionId, owner },
      );
    }
    throw err;
  }
  registerSession(ctx, session);
 // A session loaded from disk may have been sealed from a crash-interrupted
 // run during init (reconcileStaleStatus) — before this client could subscribe.
 // Forward the recovery advisory now that the client is attached.
  setImmediate(() => forwardInterruptedRecovery(ctx, session));
  return resumeHistoryPayload(session, params, {
    ...(params.readOnly ? { readOnly: true } : {}),
  });
}

export async function handleSessionHistory(
  ctx: ServerContext,
  params: SessionHistoryParams,
): Promise<SessionHistoryResult> {
  assertInitialized(ctx);
  if (!params?.sessionId) {
    throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  }
  if (typeof params.before !== "number" || !Number.isFinite(params.before) || params.before < 0) {
    throw new RpcError(ErrorCode.InvalidParams, "before must be a non-negative number");
  }
  await assertSessionInGrantScope(ctx, params.sessionId);
  const session = requireSession(ctx, params.sessionId);
  const limit =
    params.limit === undefined ? DEFAULT_RESUME_HISTORY_LIMIT : params.limit;
  return sliceHistoryBefore(session.getHistory(), params.before, limit);
}

/** Push the one-shot crash-recovery advisory to the resuming client, if the
 * session was sealed from an interrupted run when it loaded. The in-session
 * `interrupted_run` event fires during init before any client subscribes, so
 * we re-derive it from the session and deliver it as an `"event"` here. */
function forwardInterruptedRecovery(ctx: ServerContext, session: Session): void {
  // Guard: some session-like objects (test doubles) may not implement this.
  if (typeof session.getInterruptedRecovery !== "function") return;
  const recovery = session.getInterruptedRecovery();
  if (!recovery) return;
  ctx.peer.notify<EventParams>("event", {
    sessionId: session.id,
    event: { type: "interrupted_run", ...recovery },
  });
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

export async function handleSessionList(
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
  // Enrich with the live writer pid (if any) so a UI can mark a session as
  // actively owned by a process. Reads the per-session lock file; fail-soft per
  // session so a bad lock never breaks the list.
  const enrich = (s: RichSessionSummary): RichSessionSummary => {
    const owner = liveSessionLockOwner(s.id);
    return owner ? { ...s, liveWriterPid: owner.pid } : s;
  };
  // A scoped QR remote grant authorizes only a specific set of workspaces
  // (grant.cwds). Without this filter, a phone that paired for 2 workspaces
  // would see EVERY session on the daemon (the client never passes a cwd), a
  // cross-workspace leak. Restrict the list to the granted cwds. The local
  // (ungranted) connection is unaffected.
  const grant = ctx.remoteGrant;
  if (grant) {
    const allowed = grantAllowedCwds(grant);
    return {
      sessions: sessions
        .filter((s) => s.cwd && allowed.has(normalizeCwd(s.cwd)))
        .map(enrich),
    };
  }
  return { sessions: sessions.map(enrich) };
}

/**
 * Enforce that a remote grant may only touch sessions in its granted
 * workspaces. No-op for the local (ungranted) connection. Throws if the
 * session's on-disk cwd is outside the grant's cwds.
 */
async function assertSessionInGrantScope(
  ctx: ServerContext,
  sessionId: string,
): Promise<void> {
  const grant = ctx.remoteGrant;
  if (!grant) return;
  // A live session we already hold is in scope by construction (it was created
  // or resumed through a scoped path). Only disk-backed ids need checking.
  const live = liveSessions.get(sessionId)?.session ?? ctx.sessions.get(sessionId);
  const cwd = live?.cwd ?? (await loadCwdFromDisk(sessionId));
  const allowed = grantAllowedCwds(grant);
  if (!cwd || !allowed.has(normalizeCwd(cwd))) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      "Remote grant does not authorize this workspace",
    );
  }
}

export async function handleSessionPin(
  ctx: ServerContext,
  params: { sessionId: string; pinned: boolean },
): Promise<{ ok: true }> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  // Pin is one-per-workspace; core clears other pins sharing the cwd.
  await coreSetSessionPinned(params.sessionId, params.pinned === true);
  return { ok: true };
}

export async function handleSessionArchive(
  ctx: ServerContext,
  params: { sessionId: string; archived: boolean },
): Promise<{ ok: true }> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  await coreSetSessionArchived(params.sessionId, params.archived === true);
  return { ok: true };
}

export async function handleSessionFork(
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

export async function handlePermissionRespond(
  ctx: ServerContext,
  params: PermissionRespondParams,
): Promise<Record<string, never>> {
  const live = liveForRequest(params.requestId);
  if (!live || !settlePrompt(live, params.requestId, toResolution(params.decision, params.feedback), ctx)) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `no pending permission request: ${params.requestId}`,
    );
  }
  return {};
}

export async function handleQuestionRespond(
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