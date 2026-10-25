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
  listProviderTemplates,
  queryConnectorsWithStatus,
  listSelectableModels,
  listRemoteModels,
  redactProviderPreset,
  upsertUserProvider,
  deleteUserProvider,
  setUserActiveEndpoint,
  templateToPreset,
  findProviderIdForFlat,
  applyUpdate,
  checkEngineUpdate,
  currentInstalledVersion,
  mintRemotePairing,
  redeemRemotePairing,
  revokeAllRemoteControl,
  remoteGrantAllows,
  initProjectGuidance,
  installConnector,
  updateConnector,
  setConnectorEnabled,
  queryManagedSkills,
  installSkillFromConnector,
  installSkillFromArchive,
  setSkillEnabled,
  getSkillContent,
  getSkillFile,
  saveSkillContent,
  saveSkillFile,
  SKILL_CREATOR_STARTER_PROMPT,
  listScheduledTasks,
  addScheduledTask,
  updateScheduledTask,
  removeScheduledTask,
  listMcpMarkets,
  installMcpJson,
  listInstalledMcpServers,
  setMcpServerEnabled,
  inspectMcpServer,
  authorizeMcpServer,
  listLanIPv4,
  type EngineUpdateInfo,
  type ProviderPreset,
  type ProviderName,
  type ResolvedCodepilotConfig,
  type RemoteGrant,
  type CatalogListTab,
  type SkillListTab,
} from "@codepilot/core";
import QRCode from "qrcode";
import { ErrorCode, Peer, RpcError, StdioTransport } from "./rpc.js";
import { listTerminalShells, TerminalHost } from "./terminalHost.js";

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
    /** Native/system folder picker (`workspace/pickFolder`) is available. */
    workspacePick?: boolean;
    /** Scoped phone QR remote-control session (limited RPCs). */
    remoteControl?: boolean;
  };
  /** Running engine (CLI/daemon) version — distinct from IDE plugin / VSIX. */
  serverInfo?: { name: string; version: string; channel: "engine" };
}

export interface SystemUpdateCheckResult {
  engine: EngineUpdateInfo;
}

export interface SystemUpdateApplyResult {
  applied: boolean;
  version: string;
  message?: string;
}

export interface SessionSetModelParams {
  sessionId: string;
  model: string;
 /** Named provider preset id; when set, switches vendor + model. */
  providerId?: string;
  /**
   * Reasoning / extended-thinking effort. `null` turns thinking off;
   * omit to leave the session's current effort unchanged.
   */
  reasoningEffort?: "low" | "medium" | "high" | null;
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
export interface WorkspaceReadResult {
  path: string;
  content: string;
  size: number;
  hash: string;
  truncated: boolean;
  /** utf8 (default) or base64 for binary previews (images). */
  encoding?: "utf8" | "base64";
  /** MIME hint when encoding is base64 (e.g. image/png). */
  mediaType?: string;
}
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
 /** Non-image uploads; written under `~/.codepilot/projects/<hash>/uploads/`. */
  files?: { name: string; mediaType?: string; base64: string }[];
  /**
   * How to deliver the prompt when a run may already be active:
   * - `auto` (default): idle → start; busy → enqueue follow-up
   * - `queue`: always enqueue when busy; start when idle
   * - `steer`: inject into the current run (next agent turn); start when idle
   */
  delivery?: "auto" | "queue" | "steer";
}

export interface PromptSendResult {
  delivery: "started" | "queued" | "steered";
}

export interface PromptFollowupRemoveParams {
  sessionId: string;
  id: string;
}

export interface PromptFollowupUpdateParams {
  sessionId: string;
  id: string;
  text: string;
}

export interface PromptFollowupSendNowParams {
  sessionId: string;
  id: string;
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
 /** Present when the write sits outside sandbox writable roots. */
  sandboxExpand?: { path: string };
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
  const baseCaps = opts.capabilities ?? defaultCapabilities();
  const ctx: ServerContext = {
    peer,
    sessions: new Map(),
    defaultCwd: opts.remoteGrant?.cwd ?? opts.defaultCwd ?? process.cwd(),
    defaultPermissionMode: opts.defaultPermissionMode ?? "ask",
    capabilities: opts.remoteGrant
      ? {
          ...baseCaps,
          remoteControl: true,
          workspacePick: false,
          config: false,
        }
      : baseCaps,
    initialized: false,
    sessionSubs: new Map(),
    remoteGrant: opts.remoteGrant,
    terminals: new TerminalHost(),
  };

  if (opts.remoteGrant) {
    const grant = opts.remoteGrant;
    const orig = peer.onRequest.bind(peer);
    peer.onRequest = (<P, R>(method: string, handler: (params: P) => R | Promise<R>): void => {
      orig(method, async (params: P) => {
        assertRemoteMethodAllowed(grant, method);
        return handler(params);
      });
    }) as typeof peer.onRequest;
  }

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
    {
      models: Array<{
        id: string;
        contextWindowMax?: number;
        modalities?: Array<"text" | "image" | "audio" | "video">;
        maxOutputTokens?: number;
      }>;
    }
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
  peer.onRequest<Record<string, never>, SystemUpdateCheckResult>("system/update-check", () =>
    handleSystemUpdateCheck(),
  );
  peer.onRequest<Record<string, never>, SystemUpdateApplyResult>("system/update-apply", () =>
    handleSystemUpdateApply(),
  );
  peer.onRequest<
    { serveUrl: string; cwd?: string; sessionId?: string },
    {
      code: string;
      url: string;
      qrPayload: string;
      expiresAt: number;
      qrDataUrl: string;
      rewritten?: boolean;
      warning?: string;
      lanIp?: string;
    }
  >("remote/pair-mint", (p) => handleRemotePairMint(ctx, p));
  peer.onRequest<Record<string, never>, { lanIps: string[]; bindHostHint: string }>(
    "system/lan-ips",
    () => ({
      lanIps: listLanIPv4(),
      bindHostHint: "0.0.0.0",
    }),
  );
  peer.onRequest<Record<string, never>, { markets: Awaited<ReturnType<typeof listMcpMarkets>> }>(
    "mcp/markets",
    async () => ({ markets: await listMcpMarkets() }),
  );
  peer.onRequest<
    { json: string; name?: string },
    Awaited<ReturnType<typeof installMcpJson>>
  >("mcp/install-json", (p) => {
    if (!p?.json?.trim()) throw new RpcError(ErrorCode.InvalidParams, "json required");
    return installMcpJson(p.json, { name: p.name });
  });
  peer.onRequest<
    Record<string, never>,
    { servers: Awaited<ReturnType<typeof listInstalledMcpServers>> }
  >("mcp/list", async () => ({ servers: await listInstalledMcpServers() }));
  peer.onRequest<
    { name: string; enabled: boolean },
    { name: string; enabled: boolean; message: string }
  >("mcp/set-enabled", (p) => {
    if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
    return setMcpServerEnabled(p.name, p.enabled);
  });
  peer.onRequest<{ name: string }, Awaited<ReturnType<typeof inspectMcpServer>>>(
    "mcp/inspect",
    (p) => {
      if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
      return inspectMcpServer(p.name, {
        cwd: ctx.defaultCwd,
        openAuthUrl: makeMcpOpenAuthUrl(ctx),
      });
    },
  );
  peer.onRequest<{ name: string }, { state: McpOauthState; url?: string; error?: string }>(
    "mcp/oauth-start",
    (p) => handleMcpOauthStart(ctx, p),
  );
  peer.onRequest<{ name: string }, { state: McpOauthState; url?: string; error?: string }>(
    "mcp/oauth-status",
    (p) => {
      if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
      const entry = mcpOauthByName.get(p.name.trim());
      if (!entry) return { state: "idle" as const };
      return { state: entry.state, url: entry.url, error: entry.error };
    },
  );
  peer.onRequest<{ name: string }, { state: McpOauthState }>("mcp/oauth-cancel", (p) => {
    if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
    const name = p.name.trim();
    mcpOauthByName.set(name, { state: "idle" });
    return { state: "idle" as const };
  });
  peer.onRequest<{ code: string; secret: string }, { token: string; cwd: string; sessionId?: string; caps: string[] }>(
    "remote/pair-redeem",
    (p) => handleRemotePairRedeem(p),
  );
  peer.onRequest<Record<string, never>, { revoked: boolean }>("remote/revoke-all", async () => {
    await revokeAllRemoteControl();
    return { revoked: true };
  });
  peer.onRequest<{ force?: boolean; filename?: "AGENTS.md" | "CODEPILOT.md" }, { path: string; created: boolean; skipped: boolean }>(
    "workspace/init",
    (p) => handleWorkspaceInit(ctx, p),
  );
  peer.onRequest<{ sessionId: string }, { restored: string[]; deleted: string[]; label: string }>(
    "session/undo",
    (p) => handleSessionUndo(ctx, p),
  );
  peer.onRequest<{ sessionId: string }, { restored: string[]; deleted: string[]; label: string }>(
    "session/redo",
    (p) => handleSessionRedo(ctx, p),
  );
  peer.onRequest<
    { q?: string; tab?: CatalogListTab; offset?: number; limit?: number },
    Awaited<ReturnType<typeof queryConnectorsWithStatus>>
  >("connectors/list", async (p) =>
    queryConnectorsWithStatus({
      q: p?.q,
      tab: p?.tab,
      offset: p?.offset,
      limit: p?.limit,
    }),
  );
  peer.onRequest<
    { connectorId: string; values: Record<string, string> },
    { mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }
  >("connectors/install", (p) => installConnector(p));
  peer.onRequest<
    { connectorId: string; values: Record<string, string> },
    { mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }
  >("connectors/update", (p) => updateConnector(p));
  peer.onRequest<
    { connectorId: string; enabled: boolean },
    { connectorId: string; enabled: boolean; message: string }
  >("connectors/set-enabled", (p) => setConnectorEnabled(p.connectorId, p.enabled));
  peer.onRequest<
    { q?: string; tab?: SkillListTab; offset?: number; limit?: number },
    Awaited<ReturnType<typeof queryManagedSkills>>
  >("skills/list", async (p) =>
    queryManagedSkills({
      cwd: ctx.defaultCwd,
      q: p?.q,
      tab: p?.tab,
      offset: p?.offset,
      limit: p?.limit,
    }),
  );
  peer.onRequest<{ connectorId: string }, { skillPath: string; message: string }>(
    "skills/install",
    (p) => installSkillFromConnector(p.connectorId),
  );
  peer.onRequest<
    { filename: string; dataBase64: string },
    Awaited<ReturnType<typeof installSkillFromArchive>>
  >("skills/install-archive", (p) => {
    if (!p?.filename?.trim() || !p?.dataBase64?.trim()) {
      throw new RpcError(ErrorCode.InvalidParams, "filename and dataBase64 required");
    }
    return installSkillFromArchive({ filename: p.filename, dataBase64: p.dataBase64 });
  });
  peer.onRequest<
    { name: string; enabled: boolean },
    { name: string; enabled: boolean; message: string }
  >("skills/set-enabled", (p) => setSkillEnabled(p.name, p.enabled));
  peer.onRequest<{ name: string }, Awaited<ReturnType<typeof getSkillContent>>>(
    "skills/get",
    (p) => getSkillContent(p.name, ctx.defaultCwd),
  );
  peer.onRequest<
    { name: string; relativePath: string },
    Awaited<ReturnType<typeof getSkillFile>>
  >("skills/get-file", (p) => {
    if (!p?.name?.trim() || !p?.relativePath?.trim()) {
      throw new RpcError(ErrorCode.InvalidParams, "name and relativePath required");
    }
    return getSkillFile(p.name, p.relativePath, ctx.defaultCwd);
  });
  peer.onRequest<
    { name: string; markdown: string },
    Awaited<ReturnType<typeof saveSkillContent>>
  >("skills/save", (p) => saveSkillContent(p.name, p.markdown, ctx.defaultCwd));
  peer.onRequest<
    { name: string; relativePath: string; content: string },
    Awaited<ReturnType<typeof saveSkillFile>>
  >("skills/save-file", (p) => {
    if (!p?.name?.trim() || !p?.relativePath?.trim()) {
      throw new RpcError(ErrorCode.InvalidParams, "name and relativePath required");
    }
    return saveSkillFile(p.name, p.relativePath, p.content ?? "", ctx.defaultCwd);
  });
  peer.onRequest<Record<string, never>, { prompt: string }>(
    "skills/creator-prompt",
    async () => ({ prompt: SKILL_CREATOR_STARTER_PROMPT }),
  );
  peer.onRequest<Record<string, never>, { tasks: Awaited<ReturnType<typeof listScheduledTasks>> }>(
    "schedule/list",
    async () => ({ tasks: await listScheduledTasks() }),
  );
  peer.onRequest<
    {
      title: string;
      prompt: string;
      cwd?: string;
      kind: "idle" | "daily" | "interval";
      at?: string;
      everyMinutes?: number;
      idleAfterMs?: number;
      model?: string;
      providerId?: string;
      agentMode?: "chat" | "plan" | "agent";
    },
    { task: Awaited<ReturnType<typeof addScheduledTask>> }
  >("schedule/add", async (p) => ({
    task: await addScheduledTask({
      title: p.title,
      prompt: p.prompt,
      cwd: p.cwd || ctx.defaultCwd,
      kind: p.kind,
      at: p.at,
      everyMinutes: p.everyMinutes,
      idleAfterMs: p.idleAfterMs,
      model: p.model,
      providerId: p.providerId,
      agentMode: p.agentMode,
    }),
  }));
  peer.onRequest<
    {
      id: string;
      title?: string;
      prompt?: string;
      cwd?: string;
      at?: string;
      everyMinutes?: number;
      idleAfterMs?: number;
      model?: string;
      providerId?: string;
      agentMode?: "chat" | "plan" | "agent";
      enabled?: boolean;
    },
    { task: NonNullable<Awaited<ReturnType<typeof updateScheduledTask>>> }
  >("schedule/update", async (p) => {
    if (!p?.id?.trim()) throw new RpcError(ErrorCode.InvalidParams, "id required");
    const { id, ...patch } = p;
    const task = await updateScheduledTask(id, patch);
    if (!task) throw new RpcError(ErrorCode.InvalidParams, `unknown task: ${id}`);
    return { task };
  });
  peer.onRequest<{ id: string }, { removed: boolean }>("schedule/remove", async (p) => ({
    removed: await removeScheduledTask(p.id),
  }));
  peer.onRequest<PromptSendParams, PromptSendResult>(
    "prompt/send",
    (p) => handlePromptSend(ctx, p),
  );
  peer.onRequest<PromptFollowupRemoveParams, Record<string, never>>(
    "prompt/followup/remove",
    (p) => handlePromptFollowupRemove(ctx, p),
  );
  peer.onRequest<PromptFollowupUpdateParams, Record<string, never>>(
    "prompt/followup/update",
    (p) => handlePromptFollowupUpdate(ctx, p),
  );
  peer.onRequest<PromptFollowupSendNowParams, { delivery: "steered" | "started" | "missing" }>(
    "prompt/followup/sendNow",
    (p) => handlePromptFollowupSendNow(ctx, p),
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

  // Interactive workspace terminal (PTY). Not available to remote QR grants
  // (method absent from REMOTE_METHOD_CAPS → denied).
  peer.onRequest<Record<string, never>, ReturnType<typeof listTerminalShells>>(
    "terminal/list-shells",
    () => listTerminalShells(),
  );
  peer.onRequest<
    { shell?: string; cwd?: string; cols?: number; rows?: number },
    { terminalId: string; shell: string }
  >("terminal/open", async (p) => {
    if (ctx.remoteGrant) {
      throw new RpcError(ErrorCode.InvalidRequest, "Interactive terminal is not available over remote control");
    }
    const box: { id: string } = { id: "" };
    const handle = await ctx.terminals.open({
      shell: p?.shell,
      cwd: p?.cwd?.trim() || ctx.defaultCwd,
      cols: p?.cols,
      rows: p?.rows,
      onData: (data) => {
        const terminalId = box.id;
        if (!terminalId) return;
        void ctx.peer
          .notify<{ terminalId: string; data: string }>("terminal/data", {
            terminalId,
            data,
          })
          .catch(() => {});
      },
      onExit: (exitCode) => {
        const terminalId = box.id;
        if (!terminalId) return;
        void ctx.peer
          .notify<{ terminalId: string; exitCode: number }>("terminal/exit", {
            terminalId,
            exitCode,
          })
          .catch(() => {});
      },
    });
    box.id = handle.id;
    return { terminalId: handle.id, shell: handle.shell };
  });
  peer.onRequest<{ terminalId: string; data: string }, Record<string, never>>(
    "terminal/write",
    (p) => {
      if (!p?.terminalId?.trim()) throw new RpcError(ErrorCode.InvalidParams, "terminalId required");
      ctx.terminals.write(p.terminalId, p.data ?? "");
      return {};
    },
  );
  peer.onRequest<{ terminalId: string; cols: number; rows: number }, Record<string, never>>(
    "terminal/resize",
    (p) => {
      if (!p?.terminalId?.trim()) throw new RpcError(ErrorCode.InvalidParams, "terminalId required");
      ctx.terminals.resize(p.terminalId, p.cols ?? 80, p.rows ?? 24);
      return {};
    },
  );
  peer.onRequest<{ terminalId: string }, Record<string, never>>("terminal/close", (p) => {
    if (!p?.terminalId?.trim()) throw new RpcError(ErrorCode.InvalidParams, "terminalId required");
    ctx.terminals.close(p.terminalId);
    return {};
  });

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
  /**
   * Scoped phone remote-control grant. When set, privileged RPCs
   * (config, updates, workspace write, minting new QR, etc.) are denied.
   */
  remoteGrant?: RemoteGrant;
}

/** Methods a scoped remote grant may call, keyed by required capability. */
const REMOTE_METHOD_CAPS: Record<string, RemoteGrant["caps"][number] | "any"> = {
  initialize: "any",
  shutdown: "any",
  "session/list": "follow",
  "session/resume": "follow",
  "session/new": "follow",
  "session/setMode": "follow",
  "session/setModel": "follow",
  "session/getEndpoint": "follow",
  "session/fork": "follow",
  "config/get": "follow",
  "workspace/list": "follow",
  "workspace/read": "follow",
  "workspace/stat": "follow",
  "workspace/git-status": "follow",
  "workspace/git-diff": "follow",
  "workspace/browse": "follow",
  "workspace/search": "follow",
  "workspace/watch": "follow",
  "prompt/send": "prompt",
  "prompt/cancel": "cancel",
  "prompt/followup/remove": "prompt",
  "prompt/followup/update": "prompt",
  "prompt/followup/sendNow": "prompt",
  "permission/respond": "answer",
  "question/respond": "answer",
};

function assertRemoteMethodAllowed(grant: RemoteGrant, method: string): void {
  const need = REMOTE_METHOD_CAPS[method];
  if (need === undefined) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      `Remote grant does not allow method: ${method}`,
    );
  }
  if (need !== "any" && !remoteGrantAllows(grant, need)) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      `Remote grant missing capability: ${need}`,
    );
  }
}

/** True when any process-wide live session is mid-prompt (for idle scheduler). */
export function anyLiveSessionBusy(): boolean {
  for (const live of liveSessions.values()) {
    if (typeof live.session.isBusy === "function" && live.session.isBusy()) return true;
  }
  return false;
}

export interface ServerHandle {
  peer: Peer;
  close(): Promise<void>;
 /**
 * Release this connection's hold on sessions (unsubscribe from events).
 * Idle sessions with no remaining holders are disposed. Busy sessions
 * (a prompt still running) stay in the process-wide live registry so a
 * browser refresh can reconnect without cancelling the task. Explicit
 * `shutdown` force-disposes even busy sessions.
 */
  dispose(): Promise<void>;
}

type McpOauthState = "idle" | "pending" | "authorized" | "error";

interface McpOauthEntry {
  state: McpOauthState;
  url?: string;
  error?: string;
  running?: Promise<void>;
}

/** Process-wide MCP OAuth status so Settings can poll across connections. */
const mcpOauthByName = new Map<string, McpOauthEntry>();

function notifyMcpOauthRequired(name: string, url: string): void {
  for (const live of liveSessions.values()) {
    for (const holder of live.holders) {
      void holder.peer
        .notify<{ name: string; url: string }>("mcp/oauth-required", { name, url })
        .catch(() => {});
    }
  }
}

function makeMcpOpenAuthUrl(ctx: ServerContext): (serverName: string, url: string) => Promise<void> {
  return async (serverName, url) => {
    const prev = mcpOauthByName.get(serverName);
    mcpOauthByName.set(serverName, {
      state: "pending",
      url,
      error: undefined,
      running: prev?.running,
    });
    void ctx.peer
      .notify<{ name: string; url: string }>("mcp/oauth-required", { name: serverName, url })
      .catch(() => {});
    notifyMcpOauthRequired(serverName, url);
  };
}

async function handleMcpOauthStart(
  ctx: ServerContext,
  params: { name?: string },
): Promise<{ state: McpOauthState; url?: string; error?: string }> {
  const name = params?.name?.trim();
  if (!name) throw new RpcError(ErrorCode.InvalidParams, "name required");
  const existing = mcpOauthByName.get(name);
  if (existing?.state === "pending" && existing.running) {
    return { state: "pending", url: existing.url, error: existing.error };
  }
  const entry: McpOauthEntry = { state: "pending" };
  mcpOauthByName.set(name, entry);
  entry.running = (async () => {
    try {
      const r = await authorizeMcpServer(name, {
        cwd: ctx.defaultCwd,
        openAuthUrl: makeMcpOpenAuthUrl(ctx),
      });
      const cur = mcpOauthByName.get(name);
      if (!cur || cur.state === "idle") return; // cancelled
      if (r.authorized) {
        mcpOauthByName.set(name, { state: "authorized", url: cur.url });
      } else {
        mcpOauthByName.set(name, {
          state: "error",
          url: cur.url,
          error: r.error ?? "授权失败",
        });
      }
    } catch (err) {
      const cur = mcpOauthByName.get(name);
      if (!cur || cur.state === "idle") return;
      mcpOauthByName.set(name, {
        state: "error",
        url: cur.url,
        error: (err as Error).message,
      });
    }
  })();
  return { state: "pending", url: entry.url };
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
  /** Present when this connection authenticated via QR remote grant. */
  remoteGrant?: RemoteGrant;
  /** Interactive PTYs owned by this connection. */
  terminals: TerminalHost;
}

/** Per-session bookkeeping kept off the session itself. */
interface SessionExtras {
  unsubscribe: () => void;
}

/**
 * Process-wide registry of LIVE session instances, shared across every client
 * connection, with a reference count. A session is created once and reused by
 * any connection that opens it (so all clients follow the same running task).
 * Closing the last UI does NOT cancel a busy run — the session stays here
 * with zero holders until `session/resume` reattaches (or `shutdown` force-
 * disposes). Idle sessions are disposed when the last holder leaves.
 */
interface LiveSession {
  session: Session;
 /** Connections currently holding this session (refcount = size). May be empty
  * while a background run continues after the last client disconnected. */
  holders: Set<ServerContext>;
 /** Permission / question requests awaiting an answer from ANY holder. */
  prompts: Map<string, PendingPrompt>;
}
const liveSessions = new Map<string, LiveSession>();

function isBusySession(session: Session): boolean {
  try {
    return typeof session.isBusy === "function" && session.isBusy();
  } catch {
    return false;
  }
}

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

/** Release `sessionId` for this connection. When no holders remain: keep a busy
 * session alive for reconnect (unless `force`), otherwise fail-closed pending
 * prompts and dispose. */
async function releaseSession(
  ctx: ServerContext,
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!ctx.sessions.delete(sessionId)) return; // this connection didn't hold it
  const unsub = ctx.sessionSubs.get(sessionId);
  if (unsub) { try { unsub(); } catch { /* ignore */ } ctx.sessionSubs.delete(sessionId); }
  const live = liveSessions.get(sessionId);
  if (!live) return;
  live.holders.delete(ctx);
  if (live.holders.size === 0) {
 // Browser refresh / tab close: detach UI but let an in-flight prompt keep
 // running. Pending permission/question prompts stay queued for replay on
 // the next resume. Explicit shutdown passes force to tear everything down.
    if (!opts.force && isBusySession(live.session)) {
      return;
    }
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
    workspacePick: true,
    remoteControl: false,
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
    serverInfo: {
      name: "codepilot",
      version: currentInstalledVersion(),
      channel: "engine",
    },
  };
}

async function handleSystemUpdateCheck(): Promise<SystemUpdateCheckResult> {
  const engine = await checkEngineUpdate({ checkOnly: true });
  if (!engine) {
    return {
      engine: {
        channel: "engine",
        current: currentInstalledVersion(),
        latest: null,
        available: false,
        installRoot: null,
        canAutoApply: false,
      },
    };
  }
  return { engine };
}

async function handleRemotePairMint(
  ctx: ServerContext,
  params: { serveUrl: string; cwd?: string; sessionId?: string },
): Promise<{
  code: string;
  url: string;
  qrPayload: string;
  expiresAt: number;
  qrDataUrl: string;
  rewritten?: boolean;
  warning?: string;
  lanIp?: string;
}> {
  assertInitialized(ctx);
  if (!params?.serveUrl || typeof params.serveUrl !== "string") {
    throw new RpcError(ErrorCode.InvalidParams, "serveUrl required");
  }
  const minted = await mintRemotePairing({
    serveUrl: params.serveUrl,
    cwd: params.cwd || ctx.defaultCwd,
    sessionId: params.sessionId,
  });
  const qrDataUrl = await QRCode.toDataURL(minted.qrPayload, {
    width: 280,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  return {
    code: minted.code,
    url: minted.url,
    qrPayload: minted.qrPayload,
    expiresAt: minted.expiresAt,
    qrDataUrl,
    rewritten: minted.rewritten,
    warning: minted.warning,
    lanIp: minted.lanIp,
  };
}

async function handleRemotePairRedeem(
  params: { code: string; secret: string },
): Promise<{ token: string; cwd: string; sessionId?: string; caps: string[] }> {
  if (!params?.code || !params?.secret) {
    throw new RpcError(ErrorCode.InvalidParams, "code and secret required");
  }
  const r = await redeemRemotePairing(params.code, params.secret);
  return {
    token: r.grant.token,
    cwd: r.cwd,
    sessionId: r.sessionId,
    caps: [...r.grant.caps],
  };
}

async function handleWorkspaceInit(
  ctx: ServerContext,
  params: { force?: boolean; filename?: "AGENTS.md" | "CODEPILOT.md" },
): Promise<{ path: string; created: boolean; skipped: boolean }> {
  assertInitialized(ctx);
  return initProjectGuidance(ctx.defaultCwd, {
    force: params?.force === true,
    filename: params?.filename,
  });
}

async function handleSessionUndo(
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

async function handleSessionRedo(
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

async function handleSystemUpdateApply(): Promise<SystemUpdateApplyResult> {
  const check = await checkEngineUpdate();
  if (!check) {
    return {
      applied: false,
      version: currentInstalledVersion(),
      message: "Update check disabled or failed",
    };
  }
  if (!check.available || !check.latest || !check.tag) {
    return { applied: false, version: check.current, message: "Already up to date" };
  }
  if (!check.canAutoApply || !check.installRoot) {
    return {
      applied: false,
      version: check.current,
      message: "Cannot auto-apply here (not a ~/.codepilot prefix install). Run: codepilot update",
    };
  }
  const version = await applyUpdate({
    current: check.current,
    latest: check.latest,
    tag: check.tag,
    available: true,
    installRoot: check.installRoot,
  });
  return {
    applied: true,
    version,
    message: "Updated. Restart CodePilot to load the new engine.",
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
    onMcpOpenAuthUrl: makeMcpOpenAuthUrl(ctx),
  });
  return registerSession(ctx, session);
}

/**
 * `session/setModel`: switch model (and optionally provider preset) at runtime.
 */
async function handleSessionSetModel(
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

async function handleSessionGetEndpoint(
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
  templates: Awaited<ReturnType<typeof listProviderTemplates>>;
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
  const templates = await listProviderTemplates();
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
    templates,
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
    const activeModel = preset.model;
    await setUserActiveEndpoint({
      providerId: params.id,
      provider: preset.provider,
      model: activeModel,
      smallModel: preset.smallModel,
      baseURL: preset.baseURL,
      apiKey: preset.apiKey,
      contextWindow: activeModel
        ? preset.modelCapabilities?.[activeModel]?.contextWindow
        : undefined,
    });
    if (params.sessionId) {
      const session = ctx.sessions.get(params.sessionId);
      if (session) {
        await session.setEndpoint({
          providerId: params.id,
          model: activeModel ?? session.getModel(),
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
): Promise<{
  models: Array<{
    id: string;
    contextWindowMax?: number;
    modalities?: Array<"text" | "image" | "audio" | "video">;
    maxOutputTokens?: number;
  }>;
}> {
  assertInitialized(ctx);
  let provider: ProviderName = params.provider ?? "openai";
  let baseURL = params.baseURL;
  let apiKey = params.apiKey;
  if (params.providerId) {
    const tmpl = (await listProviderTemplates()).find((t) => t.id === params.providerId);
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
      "baseURL required to list models for OpenAI-compatible providers " +
        "(they have no fixed endpoint; Anthropic/Copilot/Gemini use their vendor default)",
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
 // looking up catalog templates.
    const tmpl = (await listProviderTemplates()).find((t) => t.id === params.providerId);
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
  const model = params.model ?? preset.model ?? preset.models?.[0];
  if (!model) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `no model specified for provider "${params.providerId}"; pass a model or set one in the provider preset`,
    );
  }
  const contextWindow = preset.modelCapabilities?.[model]?.contextWindow;
  if (params.persist !== false) {
    await setUserActiveEndpoint({
      providerId: params.providerId,
      provider: preset.provider as ProviderName,
      model,
      smallModel: preset.smallModel,
      baseURL: preset.baseURL,
      apiKey: preset.apiKey,
      contextWindow,
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
    onMcpOpenAuthUrl: makeMcpOpenAuthUrl(ctx),
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

async function handleWorkspaceRead(ctx: ServerContext, params: WorkspaceReadParams): Promise<WorkspaceReadResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path);
  const data = await readFile(target.abs);
  const truncated = data.byteLength > WORKSPACE_MAX_BYTES;
  const slice = data.subarray(0, WORKSPACE_MAX_BYTES);
  const hash = createHash("sha256").update(data).digest("hex");
  const ext = target.rel.includes(".") ? target.rel.slice(target.rel.lastIndexOf(".")).toLowerCase() : "";
  const mediaType = IMAGE_EXT_MIME[ext];
  if (mediaType) {
    return {
      path: target.rel,
      content: slice.toString("base64"),
      size: data.byteLength,
      hash,
      truncated,
      encoding: "base64",
      mediaType,
    };
  }
  return {
    path: target.rel,
    content: slice.toString("utf8"),
    size: data.byteLength,
    hash,
    truncated,
    encoding: "utf8",
  };
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
): Promise<PromptSendResult> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  const delivery = params.delivery ?? "auto";
  const busy = typeof session.isBusy === "function" && session.isBusy();

  if (delivery === "steer") {
    // Steer never cancels. When idle, start a normal turn so "Inject" still
    // delivers the text instead of silently falling through to a second path.
    if (busy) {
      session.steer(params.text);
      return { delivery: "steered" };
    }
    void session.prompt(params.text, params.images, params.files).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void ctx.peer
        .notify<EventParams>("event", {
          sessionId: session.id,
          event: { type: "error", message, recoverable: false },
        })
        .catch(() => {});
    });
    return { delivery: "started" };
  }

  if ((delivery === "queue" || delivery === "auto") && busy) {
    session.enqueueFollowUp({
      text: params.text,
      images: params.images,
      files: params.files,
    });
    return { delivery: "queued" };
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
  return { delivery: "started" };
}

async function handlePromptFollowupRemove(
  ctx: ServerContext,
  params: PromptFollowupRemoveParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  session.removeFollowUp(params.id);
  return {};
}

async function handlePromptFollowupUpdate(
  ctx: ServerContext,
  params: PromptFollowupUpdateParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  if (typeof session.updateFollowUp === "function") {
    session.updateFollowUp(params.id, params.text);
  }
  return {};
}

async function handlePromptFollowupSendNow(
  ctx: ServerContext,
  params: PromptFollowupSendNowParams,
): Promise<{ delivery: "steered" | "started" | "missing" }> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  if (typeof session.sendFollowUpNow !== "function") {
    return { delivery: "missing" };
  }
  const result = session.sendFollowUpNow(params.id);
  if (result === false) return { delivery: "missing" };
  return { delivery: result };
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

/** Release every session this connection owns. Soft by default (busy runs
 * survive); pass `{ force: true }` from shutdown to cancel everything. */
async function teardown(
  ctx: ServerContext,
  opts: { force?: boolean } = {},
): Promise<void> {
  stopWatcher(ctx);
  ctx.terminals.disposeAll();
  for (const id of Array.from(ctx.sessions.keys())) {
    await releaseSession(ctx, id, opts);
  }
  ctx.sessionSubs.clear();
}

async function handleShutdown(
  ctx: ServerContext,
): Promise<Record<string, never>> {
 // Client asked to shut down this connection for real — cancel busy runs too.
  await teardown(ctx, { force: true });
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
    ...(req.sandboxExpand ? { sandboxExpand: req.sandboxExpand } : {}),
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