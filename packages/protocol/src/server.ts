/**
 * CodePilot headless protocol server: bridges `@codepilot/core`'s `Session`
 * onto JSON-RPC 2.0 NDJSON. One process serves many sessions.
 */

import type {
  AgentMode,
  CodepilotConfig,
  ImageGenConfig,
  WebSearchConfig,
  CustomSearchTemplate,
  PermissionMode,
  Session,
} from "@codepilot/core";
import {
  gcProjectArtifacts,
  redactProviderPreset,
  remoteGrantAllows,
  type ProviderName,
  type RemoteGrant,
} from "@codepilot/core";
import { ErrorCode, Peer, RpcError, StdioTransport, PROTOCOL_VERSION } from "./rpc.js";
import { listTerminalShells, TerminalHost } from "./terminalHost.js";
import {
  assertInitialized,
  requireSession,
  type ServerContext,
} from "./server/context.js";
import { liveSessions, type LiveSession } from "./server/liveSessions.js";
import type { McpOauthState } from "./server/mcpOpenAuth.js";
import {
  handleCommandsExpand,
  handleCommandsList,
  handleWorkspaceBrowse,
  handleWorkspaceComplete,
  handleWorkspaceList,
  handleWorkspacePickFolder,
  handleWorkspaceRead,
  handleWorkspaceResolve,
  handleWorkspaceSearch,
  handleWorkspaceStat,
  handleWorkspaceWatch,
  handleWorkspaceWrite,
} from "./server/handlers/workspace.js";
import {
  handleGitBranches,
  handleGitCheckout,
  handleGitCommit,
  handleGitCommitMessage,
  handleGitFetch,
  handleGitInit,
  handleGitPull,
  handleGitPush,
  handleGitStage,
  handleGitUnstage,
  handleWorkspaceGitDiff,
  handleWorkspaceGitStatus,
} from "./server/handlers/git.js";
import {
  handleConfigDeleteProvider,
  handleConfigGet,
  handleConfigListRemoteModels,
  handleConfigSetActive,
  handleConfigSetImageGen,
  handleConfigSetOnboarded,
  handleConfigSetSandbox,
  handleConfigSetWebSearch,
  handleConfigUpsertProvider,
} from "./server/handlers/config.js";
import {
  handlePermissionRespond,
  handlePermissionsAdd,
  handlePermissionsList,
  handlePermissionsRemove,
  handleQuestionRespond,
  handleSessionArchive,
  handleSessionDescribeAgents,
  handleSessionDescribeHooks,
  handleSessionExport,
  handleSessionFork,
  handleSessionGetEndpoint,
  handleSessionGoal,
  handleSessionHistory,
  handleSessionList,
  handleSessionNew,
  handleSessionPin,
  handleSessionRedo,
  handleSessionResume,
  handleSessionSetMode,
  handleSessionSetModel,
  handleSessionSetPermissionMode,
  handleSessionSetPreset,
  handleSessionUndo,
  liveSessionOrThrow,
} from "./server/handlers/session.js";
export { sliceHistoryBefore, sliceHistoryTail } from "./server/handlers/session.js";
import {
  handlePromptCancel,
  handlePromptFollowupRemove,
  handlePromptFollowupSendNow,
  handlePromptFollowupUpdate,
  handlePromptResume,
  handlePromptSend,
} from "./server/handlers/prompt.js";
import {
  handleCompletionCancel,
  handleInlineCompletion,
} from "./server/handlers/completion.js";
import {
  handleConnectorsInstall,
  handleConnectorsList,
  handleConnectorsSetEnabled,
  handleConnectorsUpdate,
  handleSkillsCreatorPrompt,
  handleSkillsGet,
  handleSkillsGetFile,
  handleSkillsInstall,
  handleSkillsInstallArchive,
  handleSkillsInstallSource,
  handleSkillsList,
  handleSkillsSave,
  handleSkillsSaveFile,
  handleSkillsSetEnabled,
} from "./server/handlers/connectors.js";
import {
  defaultCapabilities,
  handleInitialize,
  handleShutdown,
  teardown,
} from "./server/handlers/lifecycle.js";
import {
  handleMcpApproveProject,
  handleMcpInspect,
  handleMcpInstallJson,
  handleMcpList,
  handleMcpListProject,
  handleMcpMarkets,
  handleMcpOauthCancel,
  handleMcpOauthStart,
  handleMcpOauthStatus,
  handleMcpSetEnabled,
} from "./server/handlers/mcp.js";
import {
  handlePluginsInspect,
  handlePluginsInstall,
  handlePluginsList,
  handlePluginsMarket,
  handlePluginsTrust,
  handlePluginsUninstall,
} from "./server/handlers/plugins.js";
import {
  handleRemotePairMint,
  handleRemotePairRedeem,
  handleRemoteRevokeAll,
} from "./server/handlers/remote.js";
import {
  handleScheduleAdd,
  handleScheduleList,
  handleScheduleRemove,
  handleScheduleUpdate,
} from "./server/handlers/schedule.js";
import {
  handleSystemLanIps,
  handleSystemUpdateApply,
  handleSystemUpdateCheck,
  handleWorkspaceInit,
} from "./server/handlers/system.js";

export type { ServerContext } from "./server/context.js";
export * from "./server/wireTypes.js";
import type {
  CommandsExpandParams,
  CommandsExpandResult,
  CommandsListParams,
  CommandsListResult,
  CompletionCancelParams,
  ConfigDeleteProviderParams,
  ConfigSetActiveParams,
  ConfigUpsertProviderParams,
  GitActionParams,
  GitBranchesResult,
  GitCheckoutParams,
  GitCommitMessageResult,
  GitCommitParams,
  GitGenericResult,
  GitPushPullParams,
  InlineCompletionParams,
  InlineCompletionResult,
  InitializeParams,
  InitializeResult,
  PermissionsAddResult,
  PermissionsEditParams,
  PermissionsListParams,
  PermissionsListResult,
  PermissionsRemoveResult,
  PermissionRespondParams,
  PromptCancelParams,
  PromptFollowupRemoveParams,
  PromptFollowupSendNowParams,
  PromptFollowupUpdateParams,
  PromptResumeParams,
  PromptResumeResult,
  PromptSendParams,
  PromptSendResult,
  QuestionRespondParams,
  SessionForkParams,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionListResult,
  SessionNewParams,
  SessionResumeParams,
  SessionResumeResult,
  SessionSetModeParams,
  SessionSetModelParams,
  SystemUpdateApplyResult,
  SystemUpdateCheckResult,
  WorkspaceBrowseParams,
  WorkspaceBrowseResult,
  WorkspaceCompleteParams,
  WorkspaceCompleteResult,
  WorkspaceGitDiffParams,
  WorkspaceGitDiffResult,
  WorkspaceGitStatusResult,
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
} from "./server/wireTypes.js";


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
    {
      provider?: WebSearchConfig["provider"];
      apiKey?: string;
      cx?: string;
      engineId?: string | null;
      env?: Record<string, string> | null;
      custom?: CustomSearchTemplate | null;
    },
    {
      webSearch: {
        provider?: string;
        hasApiKey: boolean;
        customUrl?: string;
        engineId?: string;
        custom?: CustomSearchTemplate;
        env?: Record<string, string>;
      };
    }
  >("config/setWebSearch", (p) => handleConfigSetWebSearch(ctx, p));
  peer.onRequest<{ onboardedAt?: string }, { onboardedAt: string }>(
    "config/setOnboarded",
    (p) => handleConfigSetOnboarded(ctx, p),
  );
  peer.onRequest<
    { mode?: "off" | "workspace-write" | "read-only"; sessionId?: string },
    Awaited<ReturnType<typeof handleConfigSetSandbox>>
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
  peer.onRequest<SessionHistoryParams, SessionHistoryResult>(
    "session/history",
    (p) => handleSessionHistory(ctx, p),
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
  peer.onRequest<CommandsExpandParams, CommandsExpandResult>("commands/expand", (p) =>
    handleCommandsExpand(ctx, p),
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
  peer.onRequest<Record<string, never>, ReturnType<typeof handleSystemLanIps>>(
    "system/lan-ips",
    () => handleSystemLanIps(),
  );
  peer.onRequest<Record<string, never>, Awaited<ReturnType<typeof handleMcpMarkets>>>(
    "mcp/markets",
    () => handleMcpMarkets(),
  );
  peer.onRequest<
    { json: string; name?: string },
    Awaited<ReturnType<typeof handleMcpInstallJson>>
  >("mcp/install-json", (p) => handleMcpInstallJson(p));
  peer.onRequest<Record<string, never>, Awaited<ReturnType<typeof handleMcpList>>>(
    "mcp/list",
    () => handleMcpList(),
  );
  peer.onRequest<
    { name: string; enabled: boolean },
    Awaited<ReturnType<typeof handleMcpSetEnabled>>
  >("mcp/set-enabled", (p) => handleMcpSetEnabled(p));
  peer.onRequest<{ name: string }, Awaited<ReturnType<typeof handleMcpInspect>>>(
    "mcp/inspect",
    (p) => handleMcpInspect(ctx, p),
  );
  // Project-sourced MCP servers (from a repo's `.codepilot/config.json` /
  // `.mcp.json`) are gated: they launch only after the user approves them,
  // since they can run an arbitrary command shipped with someone else's code.
  peer.onRequest<
    { cwd?: string },
    Awaited<ReturnType<typeof handleMcpListProject>>
  >("mcp/list-project", (p) => handleMcpListProject(ctx, p));
  peer.onRequest<{ name: string; cwd?: string }, Awaited<ReturnType<typeof handleMcpApproveProject>>>(
    "mcp/approve-project",
    (p) => handleMcpApproveProject(ctx, p),
  );
  peer.onRequest<{ name: string }, { state: McpOauthState; url?: string; error?: string }>(
    "mcp/oauth-start",
    (p) => handleMcpOauthStart(ctx, p),
  );
  peer.onRequest<{ name: string }, { state: McpOauthState; url?: string; error?: string }>(
    "mcp/oauth-status",
    (p) => handleMcpOauthStatus(p),
  );
  peer.onRequest<{ name: string }, ReturnType<typeof handleMcpOauthCancel>>(
    "mcp/oauth-cancel",
    (p) => handleMcpOauthCancel(p),
  );
  // Plugin marketplace + install (parallel to the mcp/* registry RPCs). The
  // market is the GitHub-hosted discovery entry point; install surfaces the
  // source via `describe` so a client can confirm before fetching code.
  peer.onRequest<
    { query?: string },
    Awaited<ReturnType<typeof handlePluginsMarket>>
  >("plugins/market", (p) => handlePluginsMarket(p));
  peer.onRequest<
    Record<string, never>,
    Awaited<ReturnType<typeof handlePluginsList>>
  >("plugins/list", () => handlePluginsList(ctx));
  // Inspect what a source WILL do before installing it: downloads to a temp
  // dir, reads the manifest, reports tools + side effects, discards the copy.
  // A client shows this so the user confirms before any plugin code lands/runs.
  peer.onRequest<{ source: string }, Awaited<ReturnType<typeof handlePluginsInspect>>>(
    "plugins/inspect",
    (p) => handlePluginsInspect(p),
  );
  peer.onRequest<{ source: string; force?: boolean }, Awaited<ReturnType<typeof handlePluginsInstall>>>(
    "plugins/install",
    (p) => handlePluginsInstall(p),
  );
  peer.onRequest<{ name: string }, Awaited<ReturnType<typeof handlePluginsUninstall>>>(
    "plugins/uninstall",
    (p) => handlePluginsUninstall(p),
  );
  // Approve a discovered plugin's current hooks / MCP servers / runtime. Project
  // plugins (shipped inside the opened repo) load none of those until approved.
  peer.onRequest<{ name: string }, Awaited<ReturnType<typeof handlePluginsTrust>>>(
    "plugins/trust",
    (p) => handlePluginsTrust(ctx, p),
  );
  peer.onRequest<{ code: string; secret: string }, Awaited<ReturnType<typeof handleRemotePairRedeem>>>(
    "remote/pair-redeem",
    (p) => handleRemotePairRedeem(p),
  );
  peer.onRequest<Record<string, never>, Awaited<ReturnType<typeof handleRemoteRevokeAll>>>(
    "remote/revoke-all",
    () => handleRemoteRevokeAll(),
  );
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
  peer.onRequest<{ sessionId: string; mode: PermissionMode }, { mode: PermissionMode }>(
    "session/setPermissionMode",
    (p) => handleSessionSetPermissionMode(ctx, p),
  );
  peer.onRequest<
    { sessionId: string; preset: import("@codepilot/core").PermissionPresetName },
    Awaited<ReturnType<typeof handleSessionSetPreset>>
  >("session/setPreset", (p) => handleSessionSetPreset(ctx, p));
  peer.onRequest<
    { sessionId: string; format?: "markdown" | "jsonl" },
    Awaited<ReturnType<typeof handleSessionExport>>
  >("session/export", (p) => handleSessionExport(ctx, p));
  peer.onRequest<
    { sessionId: string; objective: string; maxRounds?: number },
    { accepted: true; running: boolean }
  >("session/goal", (p) => handleSessionGoal(ctx, p));
  peer.onRequest<{ sessionId: string }, { text: string }>(
    "session/describeHooks",
    (p) => handleSessionDescribeHooks(ctx, p),
  );
  peer.onRequest<{ sessionId?: string; cwd?: string }, { text: string }>(
    "session/describeAgents",
    (p) => handleSessionDescribeAgents(ctx, p),
  );
  peer.onRequest<{ sessionId: string }, Array<{ messageId: string; text: string; ts?: number }>>(
    "session/rewindTargets",
    (p) => liveSessionOrThrow(ctx, p.sessionId).rewindTargets(),
  );
  peer.onRequest<
    { sessionId: string; messageId?: string; files?: boolean },
    { messageId: string; text: string; turns: number; restored: string[]; deleted: string[] }
  >("session/rewind", (p) =>
    liveSessionOrThrow(ctx, p.sessionId).rewindConversation(p.messageId, { files: p.files }),
  );
  peer.onRequest<
    { q?: string; tab?: import("@codepilot/core").CatalogListTab; offset?: number; limit?: number },
    Awaited<ReturnType<typeof handleConnectorsList>>
  >("connectors/list", (p) => handleConnectorsList(p));
  peer.onRequest<
    { connectorId: string; values: Record<string, string> },
    Awaited<ReturnType<typeof handleConnectorsInstall>>
  >("connectors/install", (p) => handleConnectorsInstall(p));
  peer.onRequest<
    { connectorId: string; values: Record<string, string> },
    Awaited<ReturnType<typeof handleConnectorsUpdate>>
  >("connectors/update", (p) => handleConnectorsUpdate(p));
  peer.onRequest<
    { connectorId: string; enabled: boolean },
    Awaited<ReturnType<typeof handleConnectorsSetEnabled>>
  >("connectors/set-enabled", (p) => handleConnectorsSetEnabled(p));
  peer.onRequest<
    { q?: string; tab?: import("@codepilot/core").SkillListTab; offset?: number; limit?: number },
    Awaited<ReturnType<typeof handleSkillsList>>
  >("skills/list", (p) => handleSkillsList(ctx, p));
  peer.onRequest<{ connectorId: string }, Awaited<ReturnType<typeof handleSkillsInstall>>>(
    "skills/install",
    (p) => handleSkillsInstall(p),
  );
  peer.onRequest<
    { filename: string; dataBase64: string },
    Awaited<ReturnType<typeof handleSkillsInstallArchive>>
  >("skills/install-archive", (p) => handleSkillsInstallArchive(p));
  // Install a skill from a git URL, remote archive URL, or local path — the
  // same source vector as plugin install. The backend already supported this
  // (`installSkillFromSource`); this RPC exposes it so clients get a "paste a
  // repo/URL" path, not only connector-catalog + zip upload.
  peer.onRequest<
    { source: string },
    Awaited<ReturnType<typeof handleSkillsInstallSource>>
  >("skills/install-source", (p) => handleSkillsInstallSource(p));
  peer.onRequest<
    { name: string; enabled: boolean },
    Awaited<ReturnType<typeof handleSkillsSetEnabled>>
  >("skills/set-enabled", (p) => handleSkillsSetEnabled(p));
  peer.onRequest<{ name: string }, Awaited<ReturnType<typeof handleSkillsGet>>>(
    "skills/get",
    (p) => handleSkillsGet(ctx, p),
  );
  peer.onRequest<
    { name: string; relativePath: string },
    Awaited<ReturnType<typeof handleSkillsGetFile>>
  >("skills/get-file", (p) => handleSkillsGetFile(ctx, p));
  peer.onRequest<
    { name: string; markdown: string },
    Awaited<ReturnType<typeof handleSkillsSave>>
  >("skills/save", (p) => handleSkillsSave(ctx, p));
  peer.onRequest<
    { name: string; relativePath: string; content: string },
    Awaited<ReturnType<typeof handleSkillsSaveFile>>
  >("skills/save-file", (p) => handleSkillsSaveFile(ctx, p));
  peer.onRequest<Record<string, never>, Awaited<ReturnType<typeof handleSkillsCreatorPrompt>>>(
    "skills/creator-prompt",
    () => handleSkillsCreatorPrompt(),
  );
  peer.onRequest<Record<string, never>, Awaited<ReturnType<typeof handleScheduleList>>>(
    "schedule/list",
    () => handleScheduleList(),
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
    Awaited<ReturnType<typeof handleScheduleAdd>>
  >("schedule/add", (p) => handleScheduleAdd(ctx, p));
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
    Awaited<ReturnType<typeof handleScheduleUpdate>>
  >("schedule/update", (p) => handleScheduleUpdate(p));
  peer.onRequest<{ id: string }, Awaited<ReturnType<typeof handleScheduleRemove>>>(
    "schedule/remove",
    (p) => handleScheduleRemove(p),
  );
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