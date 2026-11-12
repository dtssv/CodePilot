/**
 * CodePilot headless protocol server: bridges `@codepilot/core`'s `Session`
 * onto JSON-RPC 2.0 NDJSON. One process serves many sessions.
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
  ImageGenConfig,
  WebSearchConfig,
  CustomSearchTemplate,
  PermissionDecision,
  PermissionResolution,
  PermissionMode,
  PermissionRequest as CorePermissionRequest,
  QuestionAnswers,
  QuestionRequest as CoreQuestionRequest,
  Diagnostic,
  DiagnosticsProvider,
  Session,
  SessionSummary,
  UsageInfo,
} from "@codepilot/core";
import {
  createSession,
  driveGoalRounds,
  SessionLockedError,
  liveSessionLockOwner,
  gcProjectArtifacts,
  listSessions as coreListSessions,
  setSessionPinned as coreSetSessionPinned,
  setSessionArchived as coreSetSessionArchived,
  loadCwdFromDisk,
  normalizeCwd,
  type RichSessionSummary,
  loadConfig as coreLoadConfig,
  loadConfigWithSources,
  listProviderTemplates,
  listSearchEngines,
  collectPluginProviderTemplates,
  queryConnectorsWithStatus,
  listSelectableModels,
  listRemoteModels,
  redactProviderPreset,
  upsertUserProvider,
  deleteUserProvider,
  setUserActiveEndpoint,
  readUserConfigFile,
  writeUserConfigFile,
  detectSandboxBackend,
  buildSandboxUnavailable,
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
  installSkillFromSource,
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
  listPluginMarket,
  searchMarketplace,
  installPlugin,
  inspectPluginSource,
  uninstallPlugin,
  describeMarketplaceEntry,
  authorizeMcpServer,
  listLanIPv4,
  buildSingleProvider,
  PROVIDER_NAMES,
  userMessage,
  decideCompletionModel,
  buildCompletionPrompt,
  cleanCompletion,
  COMPLETION_SYSTEM_PROMPT,
  COMPLETION_MAX_TOKENS,
  discoverSlashCommands,
  discoverSkills,
  discoverPlugins,
  pluginResourcePaths,
  sharedBuiltinCommands,
  type EngineUpdateInfo,
  type ProviderPreset,
  type ProviderName,
  type ResolvedCodepilotConfig,
  type RemoteGrant,
  type CatalogListTab,
  type SkillListTab,
} from "@codepilot/core";
import QRCode from "qrcode";
import { ErrorCode, Peer, RpcError, StdioTransport, PROTOCOL_VERSION } from "./rpc.js";
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
    /** Extended git operations (git/branches, git/commit, git/push, …). */
    git?: boolean;
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
  /** Open read-only when another process holds the write lease: no lease is
   * taken and no events are appended. Used to inspect a session owned
   * elsewhere. When false/absent and a live owner holds the lease, resume
   * fails with a SESSION_LOCKED error carrying the owner's attach info. */
  readOnly?: boolean;
}

export interface SessionResumeResult {
  sessionId: string;
  events: Event[];
  /** True when the session was opened read-only (another process owns the
   * write lease); prompts and persisted edits are inert for this handle. */
  readOnly?: boolean;
}

export interface SessionListResult {
  sessions: RichSessionSummary[];
}

export interface WorkspaceListParams { path?: string; cwd?: string; }
export interface WorkspaceEntry { name: string; path: string; kind: "file" | "directory"; size?: number; }
export interface WorkspaceListResult { path: string; entries: WorkspaceEntry[]; }
/** Native OS folder dialog (server-side). Cancel → path null. */
export interface WorkspacePickFolderResult { path: string | null; supported: boolean; }
/** Browse an absolute directory on the serve host (folder picker UI). */
export interface WorkspaceBrowseParams { path?: string; cwd?: string; }
export interface WorkspaceBrowseResult {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string; kind: "file" | "directory" }>;
  roots: Array<{ label: string; path: string }>;
}
export interface WorkspaceReadParams { path: string; cwd?: string; }
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
export interface WorkspaceSearchParams { query: string; path?: string; maxResults?: number; cwd?: string; }
export interface WorkspaceSearchResult { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; }

/** Slash-command discovery for the `/` menu (shared by every client surface). */
export interface CommandsListParams { cwd?: string; }
export interface CommandInfoRpc {
  name: string;
  description: string;
  argumentHint?: string;
  /** "builtin" = shipped shared command; "project"/"user" = markdown command;
   * "plugin" = command shipped by an installed plugin. */
  source: "builtin" | "project" | "user" | "plugin";
  /** "local" = a client-side action (switch mode, open a picker, compact, …);
   * "prompt" = expands into a model turn. Built-ins are local; custom markdown
   * commands are prompt. Lets a GUI client branch without a hard-coded name list. */
  kind: "local" | "prompt";
}
export interface CommandsListResult { commands: CommandInfoRpc[]; warnings: string[]; }

/** `@`-mention completion for the composer. One endpoint, many candidate kinds. */
export type CompletionKind = "file" | "dir" | "mcp" | "git" | "skill";
export interface WorkspaceCompleteParams {
  /** Text typed after `@` (may be empty to list top candidates). */
  query: string;
  /** Restrict to specific kinds; default = all available. */
  kinds?: CompletionKind[];
  maxResults?: number;
  cwd?: string;
}
export interface CompletionCandidate {
  kind: CompletionKind;
  /** The token inserted into the prompt (what the agent resolves), e.g. the
   * path, or `@mcp:server/uri`. */
  value: string;
  /** Human label for the menu. */
  label: string;
  /** Secondary detail (relative dir, server name, symbol kind…). */
  detail?: string;
}
export interface WorkspaceCompleteResult { candidates: CompletionCandidate[]; }
/** Resolve a (possibly bare / relative) path to an absolute one the host can
 * open, using the same workspace basename fallback as workspace/read. */
export interface WorkspaceResolveParams { path: string; cwd?: string; }
export interface WorkspaceResolveResult { path: string; absolute: string; exists: boolean; }
export interface WorkspaceWriteParams { path: string; content: string; expectedSize?: number; expectedHash?: string; cwd?: string; }
export interface WorkspaceWriteResult { path: string; size: number; hash: string; }
export interface WorkspaceGitStatusResult { branch: string; files: Array<{ path: string; index: string; worktree: string; status: string }>; }
export interface WorkspaceGitDiffParams { path?: string; staged?: boolean; cwd?: string; }
export interface WorkspaceGitDiffResult { path?: string; diff: string; truncated: boolean; }

// ---- Extended Git operations (workspace panel actions) ----
export interface GitBranchesResult { current: string; branches: Array<{ name: string; current: boolean; upstream?: string; ahead?: number; behind?: number }>; tags: string[]; detached: boolean; }
export interface GitActionParams {
  cwd?: string;
  /** For stage/unstage/commit-scope: specific paths; omit = all. */
  paths?: string[];
}
export interface GitCommitParams { cwd?: string; message: string; all?: boolean; }
export interface GitPushPullParams { cwd?: string; remote?: string; branch?: string; setUpstream?: boolean; }
export interface GitCheckoutParams { cwd?: string; branch: string; create?: boolean; }
export interface GitGenericResult { ok: boolean; output: string; }
export interface GitCommitMessageResult { message: string; }

/** Inline (Tab) code completion for the editor plugins. prefix/suffix framed
 * for a future native FIM swap. Stateless: the client owns debounce / cancel / cache. */
export interface InlineCompletionParams {
  /** Text before the cursor (client-capped). */
  prefix: string;
  /** Text after the cursor (FIM-ready; chat phase uses as trailing context). */
  suffix: string;
  /** Workspace-relative path of the edited file — language inference only. */
  path: string;
  /** Opaque client token; echoed so the client can match its newest request. */
  requestId: string;
  /** Which workspace / session's provider to use. */
  cwd?: string;
  sessionId?: string;
  /** Soft cap on suggestion length (tokens). Defaults to the core small cap. */
  maxTokens?: number;
}
export interface InlineCompletionResult {
  /** Text to insert at the cursor. Empty string = no suggestion. */
  completion: string;
  /** Echoed request token for the client to match against its latest request. */
  requestId: string;
  /** Set when completion was skipped WITHOUT calling the model — currently
   * "no-small-model" when the resolved model is the main chat model (design
   * §2.5). Lets the client show the one-time "configure a lightweight
   * completion model" notice. */
  disabledReason?: string;
}
/** Cancel an in-flight inline completion by its requestId so the upstream model
 * call is aborted (stops burning tokens on a suggestion the client discarded). */
export interface CompletionCancelParams { requestId: string; }
export interface WorkspaceStatParams { path: string; cwd?: string; }
export interface WorkspaceStatResult { path: string; exists: boolean; size: number; hash: string; modifiedAt?: number; }
export interface WorkspaceWatchParams { path?: string; cwd?: string; }
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
   * `auto` (idle→start, busy→queue), `queue`, or `steer` (inject into run).
   */
  delivery?: "auto" | "queue" | "steer";
}

export interface PromptSendResult {
  delivery: "started" | "queued" | "steered";
}

export interface PromptResumeParams {
  sessionId: string;
}

export interface PromptResumeResult {
  /**
   * `started` — re-entered the last turn. `queued` — a run was already active.
   * `noop` — nothing to resume (no prior user turn, or last turn ended cleanly).
   */
  delivery: "started" | "queued" | "noop";
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
 /** `abort` = "deny & stop": refuse this call and end the whole prompt/turn. */
  decision: PermissionDecision | "abort";
 /** Decline-with-feedback: when `decision` is `"deny"`, an optional correction
  * message that is surfaced to the model as the tool result instead of a
  * canned "permission denied". Ignored for allow/always. */
  feedback?: string;
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

/** Scope of a persisted permission rule: project (`repo`) or global (`user`). */
export type PermissionRuleScope = "repo" | "user";
export type PermissionRuleEffect = "allow" | "ask" | "deny";

/** `permissions/list`: read persisted permission rules for a scope. */
export interface PermissionsListParams {
  sessionId: string;
  scope?: PermissionRuleScope;
}
export interface PermissionsListResult {
  scope: PermissionRuleScope;
  allow: string[];
  ask: string[];
  deny: string[];
}

/** `permissions/add` / `permissions/remove`: CRUD a persisted rule. The change
 * is written to the scope's config file AND hot-applied to the live session. */
export interface PermissionsEditParams {
  sessionId: string;
  rule: string;
  effect: PermissionRuleEffect;
  scope?: PermissionRuleScope;
}
export interface PermissionsAddResult {
  path: string;
}
export interface PermissionsRemoveResult {
  removed: boolean;
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

/** Wire params for the reverse `diagnostics/request` the server sends to the
 * client when the `diagnostics` tool runs. The host (an IDE with a language
 * server) answers it inline; a host with no LSP replies `unavailable`. */
export interface DiagnosticsRequestParams {
  sessionId: string;
 /** Omit for the whole workspace; present for a single file. */
  path?: string;
}

/** Inline result the client returns for `diagnostics/request`. Exactly one of
 * `diagnostics` (file request) / `files` (workspace request) is populated, or
 * `unavailable: true` when the host has no language server — then the core tool
 * prints its "not available, use bash" fallback. */
export interface DiagnosticsRequestResult {
  diagnostics?: Diagnostic[];
  files?: { path: string; diagnostics: Diagnostic[] }[];
  unavailable?: boolean;
}

// PROTOCOL_VERSION is defined in the dependency-free rpc module (so browser
// clients can import the same value); re-exported here (imported above) for
// existing `from "./server.js"` / barrel callers.
export { PROTOCOL_VERSION };
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
    pendingGoals: new Map(),
    activeGoalLoops: new Set(),
    remoteGrant: opts.remoteGrant,
    ...(opts.lockIdentity ? { lockIdentity: opts.lockIdentity } : {}),
    terminals: new TerminalHost(),
    completionAborts: new Map(),
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
  peer.onRequest<PermissionsListParams, PermissionsListResult>(
    "permissions/list",
    (p) => handlePermissionsList(ctx, p),
  );
  peer.onRequest<PermissionsEditParams, PermissionsAddResult>(
    "permissions/add",
    (p) => handlePermissionsAdd(ctx, p),
  );
  peer.onRequest<PermissionsEditParams, PermissionsRemoveResult>(
    "permissions/remove",
    (p) => handlePermissionsRemove(ctx, p),
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
    { baseURL?: string; apiKey?: string; model?: string; enabled?: boolean },
    { imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean } }
  >("config/setImageGen", (p) => handleConfigSetImageGen(ctx, p));
  peer.onRequest<
    { provider?: WebSearchConfig["provider"]; apiKey?: string; cx?: string; custom?: CustomSearchTemplate },
    { webSearch: { provider?: string; hasApiKey: boolean; customUrl?: string } }
  >("config/setWebSearch", (p) => handleConfigSetWebSearch(ctx, p));
  peer.onRequest<{ onboardedAt?: string }, { onboardedAt: string }>(
    "config/setOnboarded",
    (p) => handleConfigSetOnboarded(ctx, p),
  );
  peer.onRequest<
    { mode?: "off" | "workspace-write" | "read-only"; sessionId?: string },
    { sandbox: SandboxStatusWire }
  >("config/setSandbox", (p) => handleConfigSetSandbox(ctx, p));
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
  peer.onRequest<{ sessionId: string; pinned: boolean }, { ok: true }>("session/pin", (p) =>
    handleSessionPin(ctx, p),
  );
  peer.onRequest<{ sessionId: string; archived: boolean }, { ok: true }>("session/archive", (p) =>
    handleSessionArchive(ctx, p),
  );
  peer.onRequest<{ sessionId: string; focus?: string }, { ok: true }>("session/compact", async (p) => {
    assertInitialized(ctx);
    if (!p?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
    await requireSession(ctx, p.sessionId).compact(p.focus);
    return { ok: true };
  });
  peer.onRequest<
    { sessionId: string; dryRun?: boolean },
    { removed: number; bytesReclaimed: number; scanned: number; referenced: number }
  >("session/gc-artifacts", async (p) => {
    assertInitialized(ctx);
    if (!p?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
    // GC is per-project (the artifact store is shared across a project's
    // sessions), so resolve the session's cwd and sweep that project's store.
    const cwd = requireSession(ctx, p.sessionId).getCwd();
    const res = await gcProjectArtifacts(cwd, { dryRun: p.dryRun === true });
    return {
      removed: res.removed.length,
      bytesReclaimed: res.bytesReclaimed,
      scanned: res.scanned,
      referenced: res.referenced,
    };
  });
  peer.onRequest<{ sessionId: string; reason?: string }, { cleared: boolean }>("session/clear-context", async (p) => {
    assertInitialized(ctx);
    if (!p?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
    const cleared = await requireSession(ctx, p.sessionId).clearWorkingContext(p.reason);
    return { cleared };
  });
  // Anchor (or unanchor) a prior message against compaction. Returns the
  // current set of pinned ids so the client can reflect the toggle.
  peer.onRequest<
    { sessionId: string; messageId: string; pinned?: boolean },
    { ok: boolean; pinned: string[] }
  >("session/pinMessage", async (p) => {
    assertInitialized(ctx);
    if (!p?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
    if (!p?.messageId) throw new RpcError(ErrorCode.InvalidParams, "messageId required");
    const session = requireSession(ctx, p.sessionId);
    const ok = await session.pinMessage(p.messageId, p.pinned !== false);
    return { ok, pinned: session.pinnedMessageIds() };
  });
  peer.onRequest<
    { sessionId: string },
    ReturnType<Session["contextReport"]>
  >("session/contextReport", (p) => {
    assertInitialized(ctx);
    if (!p?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
    return requireSession(ctx, p.sessionId).contextReport();
  });
  peer.onRequest<
    { sessionId: string },
    { inputTokens: number } | null
  >("session/contextCountPrecise", (p) => {
    assertInitialized(ctx);
    if (!p?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
    return requireSession(ctx, p.sessionId).preciseContextCount();
  });
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
  peer.onRequest<WorkspaceResolveParams, WorkspaceResolveResult>("workspace/resolve", (p) =>
    handleWorkspaceResolve(ctx, p),
  );
  peer.onRequest<WorkspaceSearchParams, WorkspaceSearchResult>("workspace/search", (p) =>
    handleWorkspaceSearch(ctx, p),
  );
  peer.onRequest<CommandsListParams, CommandsListResult>("commands/list", (p) =>
    handleCommandsList(ctx, p),
  );
  peer.onRequest<WorkspaceCompleteParams, WorkspaceCompleteResult>("workspace/complete", (p) =>
    handleWorkspaceComplete(ctx, p),
  );
  peer.onRequest<WorkspaceWriteParams, WorkspaceWriteResult>("workspace/write", (p) =>
    handleWorkspaceWrite(ctx, p),
  );
  peer.onRequest<{ cwd?: string }, WorkspaceGitStatusResult>("workspace/git-status", (p) => handleWorkspaceGitStatus(ctx, p));
  peer.onRequest<WorkspaceGitDiffParams, WorkspaceGitDiffResult>("workspace/git-diff", (p) => handleWorkspaceGitDiff(ctx, p));
  peer.onRequest<{ cwd?: string }, GitBranchesResult>("git/branches", (p) => handleGitBranches(ctx, p));
  peer.onRequest<{ cwd?: string }, GitGenericResult>("git/init", (p) => handleGitInit(ctx, p));
  peer.onRequest<GitActionParams, GitGenericResult>("git/stage", (p) => handleGitStage(ctx, p));
  peer.onRequest<GitActionParams, GitGenericResult>("git/unstage", (p) => handleGitUnstage(ctx, p));
  peer.onRequest<GitCommitParams, GitGenericResult>("git/commit", (p) => handleGitCommit(ctx, p));
  peer.onRequest<GitPushPullParams, GitGenericResult>("git/push", (p) => handleGitPush(ctx, p));
  peer.onRequest<GitPushPullParams, GitGenericResult>("git/pull", (p) => handleGitPull(ctx, p));
  peer.onRequest<GitPushPullParams, GitGenericResult>("git/fetch", (p) => handleGitFetch(ctx, p));
  peer.onRequest<GitCheckoutParams, GitGenericResult>("git/checkout", (p) => handleGitCheckout(ctx, p));
  peer.onRequest<{ cwd?: string; sessionId?: string }, GitCommitMessageResult>("git/commit-message", (p) => handleGitCommitMessage(ctx, p));
  peer.onRequest<InlineCompletionParams, InlineCompletionResult>("completion/inline", (p) => handleInlineCompletion(ctx, p));
  // Cancel is fire-and-forget: the client doesn't wait on it, it just wants the
  // superseded upstream call aborted. A notification keeps the client simple.
  peer.onNotification<CompletionCancelParams>("completion/cancel", (p) => handleCompletionCancel(ctx, p));
  peer.onRequest<WorkspaceStatParams, WorkspaceStatResult>("workspace/stat", (p) => handleWorkspaceStat(ctx, p));
  peer.onRequest<WorkspaceWatchParams, WorkspaceWatchResult>("workspace/watch", (p) => handleWorkspaceWatch(ctx, p));
  peer.onRequest<Record<string, never>, SystemUpdateCheckResult>("system/update-check", () =>
    handleSystemUpdateCheck(),
  );
  peer.onRequest<Record<string, never>, SystemUpdateApplyResult>("system/update-apply", () =>
    handleSystemUpdateApply(),
  );
  peer.onRequest<
    { serveUrl: string; cwd?: string; cwds?: string[]; sessionId?: string },
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
  // Plugin marketplace + install (parallel to the mcp/* registry RPCs). The
  // market is the GitHub-hosted discovery entry point; install surfaces the
  // source via `describe` so a client can confirm before fetching code.
  peer.onRequest<
    { query?: string },
    { plugins: Awaited<ReturnType<typeof listPluginMarket>>; describe: Record<string, string> }
  >("plugins/market", async (p) => {
    const all = await listPluginMarket();
    const plugins = p?.query?.trim() ? searchMarketplace(all, p.query.trim()) : all;
    const describe: Record<string, string> = {};
    for (const e of plugins) describe[e.name] = describeMarketplaceEntry(e);
    return { plugins, describe };
  });
  peer.onRequest<Record<string, never>, { plugins: Array<{ name: string; description: string; version: string; source: string; enabled: boolean }> }>(
    "plugins/list",
    async () => {
      const discovered = await discoverPlugins(ctx.defaultCwd);
      return {
        plugins: [...discovered.values()].map((pl) => ({
          name: pl.manifest.name,
          description: pl.manifest.description,
          version: pl.manifest.version,
          source: pl.source,
          enabled: pl.manifest.enabled !== false,
        })),
      };
    },
  );
  // Inspect what a source WILL do before installing it: downloads to a temp
  // dir, reads the manifest, reports tools + side effects, discards the copy.
  // A client shows this so the user confirms before any plugin code lands/runs.
  peer.onRequest<{ source: string }, Awaited<ReturnType<typeof inspectPluginSource>>>(
    "plugins/inspect",
    async (p) => {
      if (!p?.source?.trim()) throw new RpcError(ErrorCode.InvalidParams, "source required");
      return inspectPluginSource(p.source.trim());
    },
  );
  peer.onRequest<{ source: string; force?: boolean }, { name: string; path: string }>(
    "plugins/install",
    async (p) => {
      if (!p?.source?.trim()) throw new RpcError(ErrorCode.InvalidParams, "source required");
      const path = await installPlugin(p.source.trim(), { force: p.force === true });
      return { name: path.split(/[/\\]/).filter(Boolean).pop() ?? "plugin", path };
    },
  );
  peer.onRequest<{ name: string }, { removed: boolean }>("plugins/uninstall", async (p) => {
    if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
    return { removed: await uninstallPlugin(p.name.trim()) };
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
  // Install a skill from a git URL, remote archive URL, or local path — the
  // same source vector as plugin install. The backend already supported this
  // (`installSkillFromSource`); this RPC exposes it so clients get a "paste a
  // repo/URL" path, not only connector-catalog + zip upload.
  peer.onRequest<
    { source: string },
    Awaited<ReturnType<typeof installSkillFromSource>>
  >("skills/install-source", (p) => {
    if (!p?.source?.trim()) {
      throw new RpcError(ErrorCode.InvalidParams, "source required");
    }
    return installSkillFromSource(p.source);
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
      kind: "idle" | "once" | "daily" | "weekly" | "interval" | "cron";
      at?: string;
      daysOfWeek?: number[];
      cron?: string;
      timezone?: string;
      runAt?: number;
      everyMinutes?: number;
      idleAfterMs?: number;
      delivery?: "new_session" | { sessionId: string };
      paused?: boolean;
      endsAt?: number;
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
      daysOfWeek: p.daysOfWeek,
      cron: p.cron,
      timezone: p.timezone,
      runAt: p.runAt,
      everyMinutes: p.everyMinutes,
      idleAfterMs: p.idleAfterMs,
      delivery: p.delivery,
      paused: p.paused,
      endsAt: p.endsAt,
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
      daysOfWeek?: number[];
      cron?: string;
      timezone?: string;
      runAt?: number;
      everyMinutes?: number;
      idleAfterMs?: number;
      delivery?: "new_session" | { sessionId: string };
      paused?: boolean;
      endsAt?: number;
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
  peer.onRequest<PromptResumeParams, PromptResumeResult>(
    "prompt/resume",
    (p) => handlePromptResume(ctx, p),
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
  /**
   * Identity recorded in each session's write-lease lock file so a second
   * opener can be redirected to attach here as a subscriber.
   */
  lockIdentity?: { host?: string; url?: string; token?: string };
}

/** Methods a scoped remote grant may call, keyed by required capability. */
const REMOTE_METHOD_CAPS: Record<string, RemoteGrant["caps"][number] | "any"> = {
  initialize: "any",
  shutdown: "any",
  "session/list": "follow",
  "session/contextReport": "follow",
  "session/contextCountPrecise": "follow",
  "session/pin": "follow",
  "session/archive": "follow",
  "session/resume": "follow",
  "session/new": "follow",
  "session/setMode": "follow",
  "session/setModel": "follow",
  "session/getEndpoint": "follow",
  "session/fork": "follow",
  "config/get": "follow",
  "workspace/list": "follow",
  "workspace/read": "follow",
  "workspace/resolve": "follow",
  "workspace/stat": "follow",
  "workspace/git-status": "follow",
  "workspace/git-diff": "follow",
  "git/branches": "follow",
  "workspace/browse": "follow",
  "workspace/search": "follow",
  "workspace/watch": "follow",
  "prompt/send": "prompt",
  "prompt/resume": "prompt",
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

/**
 * Deliver a scheduled run as a follow-up into an existing session. Reuses a
 * live session if present; otherwise loads from disk, prompts, waits for the
 * turn, and releases.
 */
export async function deliverScheduledFollowup(
  sessionId: string,
  prompt: string,
  loadSession: (id: string) => Promise<{ session: SessionLike; dispose: () => Promise<void> } | null>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const existing = liveSessions.get(sessionId)?.session as SessionLike | undefined;
    if (existing) {
      // Live session: prompt() starts the turn or queues it as a follow-up when
      // the session is busy. We do NOT wait here — the live session owns its own
      // turn lifecycle and the user is watching it.
      await existing.prompt(prompt);
      return { ok: true };
    }
    const loaded = await loadSession(sessionId);
    if (!loaded) return { ok: false, error: `session not found: ${sessionId}` };
    try {
      await loaded.session.prompt(prompt);
      const deadline = Date.now() + 30 * 60 * 1000;
      while (loaded.session.isBusy() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ok: true };
    } finally {
      await loaded.dispose().catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The minimal Session surface the scheduler delivery path needs. */
interface SessionLike {
  prompt(text: string): Promise<unknown>;
  isBusy(): boolean;
}

export interface ServerHandle {
  peer: Peer;
  close(): Promise<void>;
 /**
 * Release this connection's hold on sessions. Idle sessions with no holders
 * are disposed; busy sessions stay live for reconnect. `shutdown` force-
 * disposes even busy sessions.
 */
  dispose(): Promise<void>;
}

type McpOauthState = "idle" | "pending" | "authorized" | "error";

/** Wire shape of the sandbox availability status returned by
 * `config/setSandbox`. `reason` carries structured, platform-specific install
 * guidance when the active mode has no usable OS backend (fail-closed). */
type SandboxStatusWire = {
  mode: "off" | "workspace-write" | "read-only";
  unavailable: boolean;
  backend: string;
  reason?: { backend: string; platform: string; hint: string };
};

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
  /** Goal loops requested by the model (via `start_goal`) but not yet started,
   * keyed by session id. A pending entry is consumed when the triggering turn
   * settles (`status: idle`), at which point `driveGoalRounds` takes over. */
  pendingGoals: Map<string, { objective: string; maxRounds?: number }>;
  /** Session ids with a goal loop currently driving, so the idle-watcher does
   * not re-trigger on the per-round idle events the loop itself produces. */
  activeGoalLoops: Set<string>;
  /** Present when this connection authenticated via QR remote grant. */
  remoteGrant?: RemoteGrant;
  /** Daemon identity recorded in each session's write-lease lock file so a
   * second opener can be redirected to attach here. */
  lockIdentity?: { host?: string; url?: string; token?: string };
  /** Interactive PTYs owned by this connection. */
  terminals: TerminalHost;
  /** In-flight inline completions keyed by the client's opaque requestId, so a
   * `completion/cancel` notification can abort the upstream model call instead
   * of letting a discarded completion keep burning tokens. */
  completionAborts: Map<string, AbortController>;
}

/** Per-session bookkeeping kept off the session itself. */
interface SessionExtras {
  unsubscribe: () => void;
}

/**
 * Process-wide registry of LIVE sessions, shared across connections with a
 * refcount. A busy run survives the last UI closing; idle sessions are
 * disposed when the last holder leaves (or `shutdown` force-disposes).
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
  | { kind: "permission"; params: PermissionRequestParams; settle: (d: PermissionResolution) => void; declined: Set<ServerContext> }
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
  ctx.pendingGoals.delete(sessionId);
  ctx.activeGoalLoops.delete(sessionId);
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
  value: PermissionResolution | QuestionAnswers,
  from: ServerContext | null,
): boolean {
  const p = live.prompts.get(requestId);
  if (!p) return false;
  live.prompts.delete(requestId);
  if (p.kind === "permission") p.settle(value as PermissionResolution);
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
    .request<typeof p.params, { decision?: PermissionDecision; feedback?: string; answers?: QuestionAnswers } | undefined>(method, p.params)
    .then((res) => {
      if (p.kind === "permission" && res?.decision) {
        settlePrompt(live, p.params.requestId, toResolution(res.decision, res.feedback), holder);
      } else if (p.kind === "question" && res?.answers) {
        settlePrompt(live, p.params.requestId, res.answers, holder);
      }
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
    providers: [...PROVIDER_NAMES],
    modes: [...SUPPORTED_MODES],
    config: true,
    setModel: true,
    workspacePick: true,
    remoteControl: false,
    git: true,
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
  // When a turn settles (idle) and the model requested a goal loop this
  // session (via `start_goal`), take over driving rounds now. We wait for the
  // triggering turn to finish because `session.prompt()` enqueues rather than
  // reenters while busy; driving here lets the loop's own prompts run cleanly.
    if (e.type === "status" && e.status === "idle") {
      maybeStartGoalLoop(ctx, session);
    }
  });
  replaying = false;
  ctx.sessionSubs.set(session.id, unsubscribe);
  return { unsubscribe };
}

/**
 * Record a model-requested goal loop (from `start_goal`) as pending. Not
 * started here — waits for the triggering turn to settle, then
 * `maybeStartGoalLoop` takes over.
 */
function recordPendingGoal(
  ctx: ServerContext,
  sessionId: string,
  req: { objective: string; maxRounds?: number },
): boolean {
  ctx.pendingGoals.set(sessionId, {
    objective: req.objective,
    ...(req.maxRounds ? { maxRounds: req.maxRounds } : {}),
  });
  return true;
}

/**
 * On a turn settling idle: if this session has a pending goal and no loop is
 * driving, consume it and start `driveGoalRounds`. `activeGoalLoops` guards
 * against re-entry (one loop at a time).
 */
function maybeStartGoalLoop(ctx: ServerContext, session: Session): void {
  const sessionId = session.id;
  if (ctx.activeGoalLoops.has(sessionId)) return;
  const pending = ctx.pendingGoals.get(sessionId);
  if (!pending) return;
  ctx.pendingGoals.delete(sessionId);
  ctx.activeGoalLoops.add(sessionId);
  void driveGoalRounds(session, {
    objective: pending.objective,
    maxRounds: pending.maxRounds,
    // Surface per-round progress to UIs via the session's event stream (which
    // `attachSessionEvents` already relays to this connection as `event`
    // notifications). The checkpoint file remains the authoritative record.
    onCheckpoint: (info) =>
      session.emitGoalProgress({
        round: info.round,
        status: info.status,
        maxRounds: pending.maxRounds,
        reason: info.reason,
        blockedReason: info.blockedReason,
      }),
  })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void ctx.peer
        .notify<EventParams>("event", {
          sessionId,
          event: { type: "error", message, recoverable: false },
        })
        .catch(() => {});
    })
    .finally(() => {
      ctx.activeGoalLoops.delete(sessionId);
    });
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
    // A scoped remote grant may only set its default cwd to an authorized
    // workspace — otherwise every cwd-defaulting RPC would silently operate
    // outside the grant.
    assertCwdInGrantScope(ctx, params.cwd);
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
  params: { serveUrl: string; cwd?: string; cwds?: string[]; sessionId?: string },
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
    cwds: Array.isArray(params.cwds) ? params.cwds.filter((c) => typeof c === "string" && c.trim()) : undefined,
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
    model: params?.model ?? config?.model,
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
    onboardedAt?: string;
  };
  providers: Record<string, ReturnType<typeof redactProviderPreset>>;
  selectableModels: ReturnType<typeof listSelectableModels>;
  templates: Awaited<ReturnType<typeof listProviderTemplates>>;
  imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean };
  webSearch: {
    provider?: string;
    hasApiKey: boolean;
    customUrl?: string;
    engines: Awaited<ReturnType<typeof listSearchEngines>>;
  };
  sandbox: { mode: "off" | "workspace-write" | "read-only" };
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
  // Plugin-contributed templates merge on top of the bundled + GitHub catalog
  // (namespaced ids, pure data — no plugin code runs).
  const pluginTemplates = await collectPluginProviderTemplates(cwd).catch(() => []);
  const templates = await listProviderTemplates({ overlay: pluginTemplates });
  const searchEngines = await listSearchEngines().catch(() => []);
  return {
    active: {
      provider: config.provider,
      model: config.model,
      smallModel: config.smallModel,
      baseURL: config.baseURL,
      providerId: findProviderIdForFlat(config),
      hasApiKey,
      apiKeyHint,
      // The first-run marker so a remote client (TUI) can tell whether the user
      // has already completed onboarding instead of re-showing the setup guide.
      onboardedAt: config.onboardedAt,
    },
    providers,
    selectableModels: listSelectableModels(config),
    templates,
    imageGen: {
      baseURL: config.imageGen?.baseURL,
      model: config.imageGen?.model,
      enabled: config.imageGen?.enabled !== false,
      hasApiKey: !!config.imageGen?.apiKey,
    },
    webSearch: {
      provider: config.webSearch?.provider,
      hasApiKey: !!config.webSearch?.apiKey,
      customUrl: config.webSearch?.custom?.url,
      // Catalog of ready-made engines so a client can offer a picker without
      // bundling its own list.
      engines: searchEngines,
    },
    sandbox: {
      // Default mirrors core's resolveSandbox default (workspace-write).
      mode: config.sandbox?.mode ?? "workspace-write",
    },
  };
}

async function handleConfigSetSandbox(
  ctx: ServerContext,
  params: { mode?: "off" | "workspace-write" | "read-only"; sessionId?: string },
): Promise<{ sandbox: SandboxStatusWire }> {
  assertInitialized(ctx);
  const mode = params?.mode;
  if (mode !== "off" && mode !== "workspace-write" && mode !== "read-only") {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `sandbox mode must be one of: off, workspace-write, read-only`,
    );
  }
  // Persist to the user config (next session inherits it) — same merge-and-write
  // pattern as config/setImageGen; other sandbox settings are preserved.
  const { raw } = await readUserConfigFile();
  const prev =
    raw.sandbox && typeof raw.sandbox === "object"
      ? { ...(raw.sandbox as Record<string, unknown>) }
      : {};
  prev.mode = mode;
  raw.sandbox = prev;
  await writeUserConfigFile(raw);
  // Hot-apply to the live session when the client names one, so the switch takes
  // effect immediately (from the next bash command) rather than next session.
  let status: SandboxStatusWire = { mode, unavailable: false, backend: detectSandboxBackend() };
  if (params.sessionId) {
    const session = requireSession(ctx, params.sessionId);
    const live = session.setSandboxMode(mode);
    status = {
      mode: live.mode,
      unavailable: live.unavailable,
      backend: live.backend,
      reason: live.reason
        ? { backend: live.reason.backend, platform: live.reason.platform, hint: live.reason.hint }
        : undefined,
    };
  } else if (mode !== "off" && detectSandboxBackend() === "none") {
    // No live session to probe fallback policy, but the configured mode clearly
    // has no backend on this host — surface the structured guidance anyway.
    const reason = buildSandboxUnavailable();
    status.reason = { backend: reason.backend, platform: reason.platform, hint: reason.hint };
  }
  return { sandbox: status };
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

async function handleConfigSetImageGen(
  ctx: ServerContext,
  params: { baseURL?: string; apiKey?: string; model?: string; enabled?: boolean },
): Promise<{ imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean } }> {
  assertInitialized(ctx);
  const { raw } = await readUserConfigFile();
  const prev = (raw.imageGen as ImageGenConfig | undefined) ?? {};
  // Preserve the stored key when the client sends an empty placeholder.
  const apiKey =
    params.apiKey === undefined || params.apiKey === "" ? prev.apiKey : params.apiKey.trim();
  const next: ImageGenConfig = {
    baseURL: params.baseURL?.trim() || prev.baseURL,
    apiKey,
    model: params.model?.trim() || prev.model,
    enabled: params.enabled ?? prev.enabled ?? true,
  };
  raw.imageGen = next;
  await writeUserConfigFile(raw);
  return {
    imageGen: {
      baseURL: next.baseURL,
      model: next.model,
      enabled: next.enabled !== false,
      hasApiKey: !!next.apiKey,
    },
  };
}

/**
 * Persist the web_search backend to the shared user config, so every client
 * (TUI / web / desktop) that follows the same daemon inherits it. Writing an
 * empty apiKey preserves the stored one; a `custom` template is stored verbatim.
 */
async function handleConfigSetWebSearch(
  ctx: ServerContext,
  params: { provider?: WebSearchConfig["provider"]; apiKey?: string; cx?: string; custom?: CustomSearchTemplate },
): Promise<{ webSearch: { provider?: string; hasApiKey: boolean; customUrl?: string } }> {
  assertInitialized(ctx);
  const { raw } = await readUserConfigFile();
  const prev = (raw.webSearch as WebSearchConfig | undefined) ?? {};
  const apiKey =
    params.apiKey === undefined || params.apiKey === "" ? prev.apiKey : params.apiKey.trim();
  const next: WebSearchConfig = { ...prev };
  if (params.provider !== undefined) next.provider = params.provider;
  if (apiKey !== undefined) next.apiKey = apiKey;
  if (params.cx !== undefined) next.cx = params.cx.trim() || undefined;
  if (params.custom !== undefined) next.custom = params.custom;
  // DuckDuckGo is keyless; clear a stale key/template so it doesn't leak through.
  if (next.provider === "duckduckgo") {
    next.apiKey = undefined;
    next.custom = undefined;
  }
  raw.webSearch = next;
  await writeUserConfigFile(raw);
  return {
    webSearch: {
      provider: next.provider,
      hasApiKey: !!next.apiKey,
      customUrl: next.custom?.url,
    },
  };
}

/**
 * Stamp the first-run marker in the shared user config so every client (TUI /
 * web / desktop) following the same daemon knows onboarding is done and does
 * not re-show its setup guide. Idempotent; keeps an existing marker.
 */
async function handleConfigSetOnboarded(
  ctx: ServerContext,
  params: { onboardedAt?: string },
): Promise<{ onboardedAt: string }> {
  assertInitialized(ctx);
  const { raw } = await readUserConfigFile();
  const existing = typeof raw.onboardedAt === "string" ? raw.onboardedAt : undefined;
  const stamp = existing ?? params.onboardedAt ?? new Date().toISOString();
  raw.onboardedAt = stamp;
  await writeUserConfigFile(raw);
  return { onboardedAt: stamp };
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

function assertRuleEffect(effect: unknown): PermissionRuleEffect {
  if (effect === "allow" || effect === "ask" || effect === "deny") return effect;
  throw new RpcError(ErrorCode.InvalidParams, `invalid effect: ${String(effect)}`);
}

/** `permissions/list`: persisted rules for a scope (repo default). */
async function handlePermissionsList(
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
async function handlePermissionsAdd(
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
async function handlePermissionsRemove(
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

async function handleSessionResume(
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
    retainSession(ctx, existing);
    attachSessionEvents(ctx, existing);
 // After the resume response, so the client has the session open first.
    setImmediate(() => {
      replayPrompts(ctx, existing.id);
      forwardInterruptedRecovery(ctx, existing);
    });
    return { sessionId: existing.id, events: existing.getHistory() };
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
    // re-open read-only (session/resume with readOnly:true).
    if (err instanceof SessionLockedError) {
      throw new RpcError(
        ErrorCode.SessionLocked,
        err.message,
        { sessionId: err.sessionId, owner: err.owner },
      );
    }
    throw err;
  }
  registerSession(ctx, session);
 // A session loaded from disk may have been sealed from a crash-interrupted
 // run during init (reconcileStaleStatus) — before this client could subscribe.
 // Forward the recovery advisory now that the client is attached.
  setImmediate(() => forwardInterruptedRecovery(ctx, session));
  return {
    sessionId: session.id,
    events: session.getHistory(),
    ...(params.readOnly ? { readOnly: true } : {}),
  };
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

/** Normalized set of workspaces a remote grant authorizes. */
function grantAllowedCwds(grant: RemoteGrant): Set<string> {
  const list = grant.cwds && grant.cwds.length > 0 ? grant.cwds : [grant.cwd];
  return new Set(list.filter((c): c is string => !!c).map((c) => normalizeCwd(c)));
}

/**
 * Enforce that a scoped remote grant may only act on an authorized workspace
 * (no-op for local). Checked at every cwd entry point, not just `session/list`,
 * so a remote client can't target an arbitrary directory outside its grant.
 */
function assertCwdInGrantScope(ctx: ServerContext, cwd: string | undefined): void {
  const grant = ctx.remoteGrant;
  if (!grant) return;
  if (!cwd || typeof cwd !== "string" || !cwd.trim()) return;
  const allowed = grantAllowedCwds(grant);
  if (!allowed.has(normalizeCwd(cwd))) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      "Remote grant does not authorize this workspace",
    );
  }
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

async function handleSessionPin(
  ctx: ServerContext,
  params: { sessionId: string; pinned: boolean },
): Promise<{ ok: true }> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  // Pin is one-per-workspace; core clears other pins sharing the cwd.
  await coreSetSessionPinned(params.sessionId, params.pinned === true);
  return { ok: true };
}

async function handleSessionArchive(
  ctx: ServerContext,
  params: { sessionId: string; archived: boolean },
): Promise<{ ok: true }> {
  assertInitialized(ctx);
  if (!params?.sessionId) throw new RpcError(ErrorCode.InvalidParams, "sessionId required");
  await coreSetSessionArchived(params.sessionId, params.archived === true);
  return { ok: true };
}

const WORKSPACE_MAX_BYTES = 512 * 1024;
function workspacePath(ctx: ServerContext, input: string | undefined, cwd?: string): { abs: string; rel: string } {
  const rel = input ?? ".";
  // A remote grant may only read/list against an authorized workspace root.
  assertCwdInGrantScope(ctx, cwd);
  // Prefer an explicit workspace root (the folder the client has open) over
  // the daemon's process cwd, so file/folder paths resolve against the active
  // workspace in multi-workspace setups.
  const root = cwd && cwd.trim() ? resolve(cwd) : resolve(ctx.defaultCwd);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + "/")) throw new RpcError(ErrorCode.InvalidRequest, "workspace path escapes cwd");
  return { abs, rel: relative(root, abs) || "." };
}

async function handleWorkspaceList(ctx: ServerContext, params: WorkspaceListParams): Promise<WorkspaceListResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
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
async function handleWorkspaceResolve(ctx: ServerContext, params: WorkspaceResolveParams): Promise<WorkspaceResolveResult> {
  assertInitialized(ctx);
  const root = resolve(params.cwd && params.cwd.trim() ? params.cwd : ctx.defaultCwd);
  const target = workspacePath(ctx, params.path, params.cwd);
  const direct = await stat(target.abs).then(() => true).catch(() => false);
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
  const want = requested.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
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
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      if (name === ".git" || name === "node_modules" || name === ".codepilot" || name === "dist") continue;
      const abs = join(dir, name);
      let info;
      try { info = await stat(abs); } catch { continue; }
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

async function handleWorkspaceSearch(ctx: ServerContext, params: WorkspaceSearchParams): Promise<WorkspaceSearchResult> {
  assertInitialized(ctx);
  const target = workspacePath(ctx, params.path, params.cwd);
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

/** List slash commands for the `/` menu: shared built-ins + project/user
 * markdown commands. Shared across every client surface — the TUI, web, and
 * IDE clients all render the same set. Client-only built-ins (exit, remote,
 * connect) are intentionally omitted (they live in the client). */
async function handleCommandsList(ctx: ServerContext, params?: CommandsListParams): Promise<CommandsListResult> {
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
  } catch (err) {
    warnings.push(`slash-command discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { commands, warnings };
}

/** First live session whose cwd matches (for MCP resource listing). Falls back
 * to any live session, or null. */
function liveSessionForCwd(ctx: ServerContext, cwd: string): Session | null {
  const want = resolve(cwd);
  let any: Session | null = null;
  for (const s of ctx.sessions.values()) {
    any = s;
    try { if (resolve(s.getCwd?.() ?? ctx.defaultCwd) === want) return s; } catch { /* ignore */ }
  }
  return any;
}

const COMPLETION_IGNORE_DIRS = new Set([".git", "node_modules", ".codepilot", "dist", "build", "out", "target", ".next", ".venv", "venv", "__pycache__", "coverage", ".idea", ".gradle"]);

/** Unified `@`-mention completion: server ranks candidates across kinds
 * (file/dir/mcp/git/skill); the inserted `value` is a token the agent
 * resolves at prompt time (server does not inline content). */
async function handleWorkspaceComplete(ctx: ServerContext, params: WorkspaceCompleteParams): Promise<WorkspaceCompleteResult> {
  assertInitialized(ctx);
  assertCwdInGrantScope(ctx, params.cwd);
  const cwd = params.cwd?.trim() ? resolve(params.cwd) : resolve(ctx.defaultCwd);
  const query = (params.query ?? "").trim();
  const ql = query.toLowerCase();
  const max = Math.min(Math.max(params.maxResults ?? 20, 1), 100);
  const kinds = new Set<CompletionKind>(params.kinds ?? ["file", "dir", "mcp", "git", "skill"]);
  const out: CompletionCandidate[] = [];

  // --- files + dirs: shallow ranked walk, honouring the query as a fuzzy-ish
  // substring on the relative path. Bounded so a huge repo can't stall.
  if (kinds.has("file") || kinds.has("dir")) {
    const hits: Array<{ rel: string; dir: boolean; score: number }> = [];
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (visited > 4000 || depth > 8) return;
      let names: string[];
      try { names = await readdir(dir); } catch { return; }
      for (const name of names) {
        if (COMPLETION_IGNORE_DIRS.has(name)) continue;
        if (name.startsWith(".") && !ql.startsWith(".")) continue;
        visited++;
        const abs = join(dir, name);
        let info: Awaited<ReturnType<typeof stat>>;
        try { info = await stat(abs); } catch { continue; }
        const rel = relative(cwd, abs);
        const rell = rel.toLowerCase();
        const isDir = info.isDirectory();
        if ((isDir && kinds.has("dir")) || (!isDir && kinds.has("file"))) {
          if (!ql || rell.includes(ql) || name.toLowerCase().includes(ql)) {
            // Prefer basename matches and shallower paths.
            const base = name.toLowerCase();
            const score = (base === ql ? 0 : base.startsWith(ql) ? 1 : base.includes(ql) ? 2 : 3) * 100 + rel.split(/[/\\]/).length;
            hits.push({ rel, dir: isDir, score });
          }
        }
        if (isDir) await walk(abs, depth + 1);
        if (hits.length > max * 8) break;
      }
    };
    await walk(cwd, 0);
    hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
    for (const h of hits.slice(0, max)) {
      out.push({ kind: h.dir ? "dir" : "file", value: h.rel, label: h.rel, detail: h.dir ? "directory" : undefined });
    }
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
    } catch { /* MCP optional */ }
  }

  // --- git: changed files (so `@git:path` or `@path` of a dirty file is easy).
  if (kinds.has("git")) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "-uall"]);
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const p = line.slice(3);
        if (!ql || p.toLowerCase().includes(ql)) {
          out.push({ kind: "git", value: p, label: p, detail: `git ${line.slice(0, 2).trim() || "·"}` });
        }
      }
    } catch { /* not a repo */ }
  }

  // --- skills (so a user can reference a skill by name).
  if (kinds.has("skill")) {
    try {
      const skills = await discoverSkills(cwd);
      for (const s of skills) {
        if (!ql || s.name.toLowerCase().includes(ql)) {
          out.push({ kind: "skill", value: s.name, label: s.name, detail: s.description?.slice(0, 80) });
        }
      }
    } catch { /* skills optional */ }
  }

  return { candidates: out.slice(0, max) };
}

/** Resolve the git working directory: explicit workspace cwd over daemon cwd.
 * Also enforces the remote-grant scope — git RPCs can read and mutate a repo,
 * so a scoped phone must not run them against an unauthorized workspace. */
function gitCwd(ctx: ServerContext, cwd?: string): string {
  assertCwdInGrantScope(ctx, cwd);
  return cwd && cwd.trim() ? resolve(cwd) : resolve(ctx.defaultCwd);
}

async function handleWorkspaceGitStatus(ctx: ServerContext, params?: { cwd?: string }): Promise<WorkspaceGitStatusResult> {
  assertInitialized(ctx);
  try {
    const { stdout } = await execFileAsync("git", ["-C", gitCwd(ctx, params?.cwd), "status", "--short", "--branch", "--porcelain=v1", "-uall"]);
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
  const target = workspacePath(ctx, params.path, params.cwd);
  try {
    const info = await stat(target.abs);
    if (!info.isFile()) return { path: target.rel, exists: false, size: 0, hash: "" };
    const data = await readFile(target.abs);
    return { path: target.rel, exists: true, size: info.size, hash: createHash("sha256").update(data).digest("hex"), modifiedAt: info.mtimeMs };
  } catch { return { path: target.rel, exists: false, size: 0, hash: "" }; }
}

async function handleWorkspaceGitDiff(ctx: ServerContext, params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = ["-C", root, "diff", "--no-ext-diff", "--no-color", "--no-renames"];
  if (params.staged) args.push("--cached");
  if (params.path) args.push("--", workspacePath(ctx, params.path, params.cwd).rel);
  try {
    const { stdout } = await execFileAsync("git", args, { maxBuffer: 1024 * 1024 });
    const bytes = Buffer.from(stdout, "utf8");
    const truncated = bytes.byteLength > WORKSPACE_MAX_BYTES;
    return { path: params.path, diff: bytes.subarray(0, WORKSPACE_MAX_BYTES).toString("utf8"), truncated };
  } catch (err) { throw new RpcError(ErrorCode.InvalidRequest, `git diff unavailable: ${err instanceof Error ? err.message : String(err)}`); }
}

/** Run a git subcommand in the workspace, returning combined output. */
async function runGit(root: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 4 * 1024 * 1024 });
    return (stdout + (stderr ? `\n${stderr}` : "")).trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = (e.stderr || e.stdout || e.message || String(err)).trim();
    throw new RpcError(ErrorCode.InvalidRequest, msg);
  }
}

async function handleGitBranches(ctx: ServerContext, params?: { cwd?: string }): Promise<GitBranchesResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params?.cwd);
  const out = await runGit(root, ["branch", "--list", "-vv", "--no-color", "--sort=-committerdate"]);
  const branches: GitBranchesResult["branches"] = [];
  let current = "";
  let detached = false;
  for (const raw of out.split(/\r?\n/).filter(Boolean)) {
    const isCurrent = raw.startsWith("*");
    const line = raw.replace(/^\*?\s+/, "");
    // Detached HEAD shows as "(HEAD detached at abc123)".
    if (line.startsWith("(HEAD")) {
      if (isCurrent) { detached = true; current = line.replace(/[()]/g, ""); }
      continue;
    }
    const name = line.split(/\s+/)[0] ?? "";
    if (!name) continue;
    const upstreamMatch = line.match(/\[([^\]:]+)(?::\s*(ahead \d+)?,?\s*(behind \d+)?)?\]/);
    const upstream = upstreamMatch?.[1];
    const ahead = upstreamMatch?.[2] ? Number(upstreamMatch[2].replace("ahead ", "")) : undefined;
    const behind = upstreamMatch?.[3] ? Number(upstreamMatch[3].replace("behind ", "")) : undefined;
    branches.push({ name, current: isCurrent, upstream, ahead, behind });
    if (isCurrent) current = name;
  }
  // Recent tags (newest first). Best-effort — empty on repos without tags.
  let tags: string[] = [];
  try {
    const tagOut = await runGit(root, ["tag", "--sort=-creatordate", "--list"]);
    tags = tagOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    tags = [];
  }
  return { current, branches, tags, detached };
}

async function handleGitInit(ctx: ServerContext, params?: { cwd?: string }): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const output = await runGit(gitCwd(ctx, params?.cwd), ["init"]);
  return { ok: true, output };
}

async function handleGitStage(ctx: ServerContext, params: GitActionParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = params.paths && params.paths.length > 0 ? ["add", "--", ...params.paths] : ["add", "-A"];
  const output = await runGit(root, args);
  return { ok: true, output };
}

async function handleGitUnstage(ctx: ServerContext, params: GitActionParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = params.paths && params.paths.length > 0 ? ["restore", "--staged", "--", ...params.paths] : ["reset", "-q"];
  const output = await runGit(root, args);
  return { ok: true, output };
}

async function handleGitCommit(ctx: ServerContext, params: GitCommitParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  if (!params.message || !params.message.trim()) throw new RpcError(ErrorCode.InvalidParams, "commit message required");
  const root = gitCwd(ctx, params.cwd);
  const args = ["commit", "-m", params.message];
  if (params.all) args.splice(1, 0, "-a");
  const output = await runGit(root, args);
  return { ok: true, output };
}

async function handleGitPush(ctx: ServerContext, params: GitPushPullParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = ["push"];
  if (params.setUpstream && params.remote && params.branch) args.push("-u", params.remote, params.branch);
  else { if (params.remote) args.push(params.remote); if (params.branch) args.push(params.branch); }
  const output = await runGit(root, args);
  return { ok: true, output };
}

async function handleGitPull(ctx: ServerContext, params: GitPushPullParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params.cwd);
  const args = ["pull", "--no-rebase"];
  if (params.remote) args.push(params.remote);
  if (params.branch) args.push(params.branch);
  const output = await runGit(root, args);
  return { ok: true, output };
}

async function handleGitFetch(ctx: ServerContext, params: GitPushPullParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  const output = await runGit(gitCwd(ctx, params.cwd), ["fetch", "--all", "--prune"]);
  return { ok: true, output };
}

async function handleGitCheckout(ctx: ServerContext, params: GitCheckoutParams): Promise<GitGenericResult> {
  assertInitialized(ctx);
  if (!params.branch || !params.branch.trim()) throw new RpcError(ErrorCode.InvalidParams, "branch required");
  const root = gitCwd(ctx, params.cwd);
  const args = params.create ? ["checkout", "-b", params.branch] : ["checkout", params.branch];
  const output = await runGit(root, args);
  return { ok: true, output };
}

/** Generate a commit message from the staged diff using the active model. */
async function handleGitCommitMessage(ctx: ServerContext, params?: { cwd?: string; sessionId?: string }): Promise<GitCommitMessageResult> {
  assertInitialized(ctx);
  const root = gitCwd(ctx, params?.cwd);
  let diff = await runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--stat", "-p"]);
  if (!diff.trim()) {
    // Nothing staged — fall back to the full working-tree diff.
    diff = await runGit(root, ["diff", "--no-ext-diff", "--no-color", "--stat", "-p"]);
  }
  if (!diff.trim()) throw new RpcError(ErrorCode.InvalidRequest, "no changes to describe");
  // Cap the diff we send to the model.
  const capped = diff.length > 12000 ? `${diff.slice(0, 12000)}\n…(diff truncated)` : diff;

  // Use the model the workspace's conversation is using: prefer the active
  // session passed by the client, else any live session in this workspace.
  // Fall back to on-disk config when no session is live.
  let live = params?.sessionId ? liveSessions.get(params.sessionId) : undefined;
  if (!live) {
    for (const s of liveSessions.values()) {
      if (resolve(s.session.cwd) === root) {
        live = s;
        break;
      }
    }
  }
  let provider: ReturnType<typeof buildSingleProvider>;
  let model: string;
  // Commit messages are a lightweight one-shot: prefer the workspace
  // conversation's PROVIDER (reachable, user's account) but use its small
  // model when available so we don't hammer the rate-limited chat model.
  // Also relax the retry policy so a transient 429 doesn't abort after a few
  // tries the way the chat loop's fast-fail does.
  const patientRetry = { retryAbortOnDelayMs: 0, maxRetries: 3, baseRetryDelayMs: 1000 };
  if (live) {
    try {
      const cfg = { ...live.session.getConfig(), ...patientRetry };
      provider = buildSingleProvider(cfg);
      model = provider.smallModel || live.session.getModel() || provider.defaultModel;
    } catch (err) {
      throw new RpcError(ErrorCode.InternalError, `no model configured for commit messages: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    const config = { ...((await loadConfigSafe(root)) ?? {}), ...patientRetry };
    try {
      provider = buildSingleProvider(config);
    } catch (err) {
      throw new RpcError(ErrorCode.InternalError, `no model configured for commit messages: ${err instanceof Error ? err.message : String(err)}`);
    }
    model = provider.smallModel || provider.defaultModel;
  }
  const systemPrompt =
    "You write concise git commit messages in the Conventional Commits style. " +
    "Return ONLY the commit message — a short imperative subject line (≤ 72 chars), " +
    "optionally followed by a blank line and a brief body. No code fences, no preamble.";
  const prompt = `Write a commit message for this diff:\n\n${capped}`;
  let text = "";
  try {
    for await (const ev of provider.stream({
      model,
      systemPrompt,
      messages: [userMessage(prompt)],
      maxTokens: 400,
    })) {
      if (ev.kind === "text_delta") text += ev.text;
      else if (ev.kind === "error") throw new Error(ev.message);
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const rateLimited = /rate.?limit|429|backoff|fast-fail|too many requests/i.test(raw);
    const hint = rateLimited
      ? " The model is being rate-limited — set a lighter `smallModel` in settings, or try again shortly."
      : "";
    throw new RpcError(ErrorCode.InternalError, `commit message generation failed: ${raw}${hint}`);
  }
  const message = text.trim().replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  if (!message) throw new RpcError(ErrorCode.InternalError, "model returned an empty commit message");
  return { message };
}

// Inline (Tab) code completion. Mirrors the commit-message template but:
//   1. never runs on the main chat model (design §2.5); and
//   2. FAST-FAIL retry (one attempt, short timeout) — a late completion is
//      worse than none.
// Stateless: the editor plugins own debounce / cancel / cache (§5.1).
async function handleInlineCompletion(ctx: ServerContext, params: InlineCompletionParams): Promise<InlineCompletionResult> {
  assertInitialized(ctx);
  const requestId = params.requestId;
  const empty = (disabledReason?: string): InlineCompletionResult =>
    disabledReason ? { completion: "", requestId, disabledReason } : { completion: "", requestId };

  if (!params.prefix && !params.suffix) return empty();

  const root = gitCwd(ctx, params.cwd);
  let live = params.sessionId ? liveSessions.get(params.sessionId) : undefined;
  if (!live) {
    for (const s of liveSessions.values()) {
      if (resolve(s.session.cwd) === root) { live = s; break; }
    }
  }

  // Fast-fail retry: a single attempt with a short abort budget. A completion
  // that arrives after the next keystroke is useless.
  const fastFail = { maxRetries: 0, retryAbortOnDelayMs: 2000 };
  let provider: ReturnType<typeof buildSingleProvider>;
  let mainModel: string;
  let completionModel: string | undefined;
  let useFim = false;
  try {
    if (live) {
      const cfg = { ...live.session.getConfig(), ...fastFail };
      provider = buildSingleProvider(cfg);
      mainModel = live.session.getModel() || provider.defaultModel;
      completionModel = cfg.completion?.model;
      useFim = cfg.completion?.fim === true;
    } else {
      const cfg = { ...((await loadConfigSafe(root)) ?? {}), ...fastFail };
      provider = buildSingleProvider(cfg);
      mainModel = provider.defaultModel;
      completionModel = cfg.completion?.model;
      useFim = cfg.completion?.fim === true;
    }
  } catch {
    // No model configured — nothing to complete with.
    return empty();
  }

  const decision = decideCompletionModel({
    mainModel,
    smallModel: provider.smallModel,
    completionModel,
  });
  if (!decision.run) return empty(decision.disabledReason);

  const maxTokens = params.maxTokens && params.maxTokens > 0 ? params.maxTokens : COMPLETION_MAX_TOKENS;

  // Abort the upstream model call when the client cancels (completion/cancel)
  // so a superseded completion stops burning tokens instead of running to
  // completion. The controller is registered under the client's requestId; an
  // already-registered id from a stale duplicate is aborted first.
  ctx.completionAborts.get(requestId)?.abort();
  const controller = new AbortController();
  ctx.completionAborts.set(requestId, controller);
  const clearAbort = (): void => {
    if (ctx.completionAborts.get(requestId) === controller) ctx.completionAborts.delete(requestId);
  };

  // Native FIM path (opt-in + provider supports it): one non-streaming call
  // with prefix+suffix, strictly lower latency than the chat wrapper. Falls
  // back to the chat path on any FIM error (fast-fail).
  if (useFim && typeof provider.fim === "function") {
    try {
      const r = await provider.fim({
        model: decision.model,
        prefix: params.prefix,
        suffix: params.suffix,
        maxTokens,
        signal: controller.signal,
      });
      return { completion: cleanCompletion(r.text, params.prefix), requestId };
    } catch {
      return empty();
    } finally {
      clearAbort();
    }
  }

  const prompt = buildCompletionPrompt({ prefix: params.prefix, suffix: params.suffix, path: params.path });
  let raw = "";
  try {
    for await (const ev of provider.stream({
      model: decision.model,
      systemPrompt: COMPLETION_SYSTEM_PROMPT,
      messages: [userMessage(prompt)],
      maxTokens,
      signal: controller.signal,
    })) {
      if (ev.kind === "text_delta") raw += ev.text;
      else if (ev.kind === "error") throw new Error(ev.message);
    }
  } catch {
    // Fast-fail: any error (including a rate-limit or an abort) yields no
    // suggestion rather than a late one. The client simply shows nothing.
    return empty();
  } finally {
    clearAbort();
  }

  const completion = cleanCompletion(raw, params.prefix);
  return { completion, requestId };
}

/** Abort an in-flight inline completion by requestId. Idempotent: an unknown or
 * already-finished id is a no-op. Fire-and-forget (no reply). */
function handleCompletionCancel(ctx: ServerContext, params: CompletionCancelParams): void {
  if (!ctx.initialized) return;
  const controller = ctx.completionAborts.get(params.requestId);
  if (controller) {
    controller.abort();
    ctx.completionAborts.delete(params.requestId);
  }
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
  const target = workspacePath(ctx, params.path, params.cwd);
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
  const target = workspacePath(ctx, params.path, params.cwd);
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

async function handlePromptResume(
  ctx: ServerContext,
  params: PromptResumeParams,
): Promise<PromptResumeResult> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  // Nothing to resume (no prior user turn, or the last turn ended cleanly):
  // report `noop` so the client can fall back to a normal send.
  if (!session.canResumeLastTurn()) {
    return { delivery: "noop" };
  }
  // Fire-and-forget: the resumed turn's events stream back as `event`
  // notifications, exactly like a normal prompt.
  void session.resumeLastTurn().catch((err: unknown) => {
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
  if (!live || !settlePrompt(live, params.requestId, toResolution(params.decision, params.feedback), ctx)) {
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
 * Issue a server-initiated `permission/request` and resolve with the client's
 * `permission/respond` decision. The wire requestId is `<sessionId>#<coreId>`
 * for global uniqueness; the client echoes it back unchanged.
 */
async function requestPermissionFromClient(
  ctx: ServerContext,
  session: Session,
  req: CorePermissionRequest,
): Promise<PermissionResolution> {
  const live = liveFor(ctx, session);
  const params: PermissionRequestParams = {
    sessionId: session.id,
    requestId: `${session.id}#${req.requestId}`,
    toolName: req.toolName,
    input: req.input,
    reason: req.reason,
    ...(req.sandboxExpand ? { sandboxExpand: req.sandboxExpand } : {}),
  };
  return new Promise<PermissionResolution>((settle) => {
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

/** Build a core `PermissionResolution` from a wire decision + optional
 * feedback. Feedback only matters on a deny; allow/always pass through as the
 * bare decision string. */
function toResolution(
  decision: PermissionDecision | "abort",
  feedback?: string,
): PermissionResolution {
  if (decision === "abort") return { decision: "abort" };
  if (decision === "deny" && feedback && feedback.trim().length > 0) {
    return { decision: "deny", feedback };
  }
  return decision;
}

function defaultDecision(mode: PermissionMode): PermissionDecision {
  switch (mode) {
    case "yolo":
    case "auto-edit":
      return "allow";
    // `auto` / `dont-ask` resolve soft asks inside the agent (classifier /
    // immediate deny); if a request still reaches here with no handler, fail
    // closed like `ask`.
    case "auto":
    case "dont-ask":
    case "ask":
    default:
      return "deny";
  }
}

/**
 * Issue a server-initiated `question/request` and resolve with the client's
 * `question/respond` answers. Same `<sessionId>#<id>` wire-id as permission.
 * Transport failure resolves with empty answers (fail-closed).
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
 * Bridge core `DiagnosticsProvider` to a server-initiated
 * `diagnostics/request` — a direct fetch from the owning connection (not
 * broadcast). No-LS → `unavailable` → provider returns an empty set.
 */
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
      return res.unavailable ? [] : (res.diagnostics ?? []);
    },
    async forWorkspace() {
      const res = await ask();
      return res.unavailable ? [] : (res.files ?? []);
    },
  };
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