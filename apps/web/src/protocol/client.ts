// Browser-side protocol client: wraps `Peer` with the CodePilot method surface,
// turning `permission/request` and `question/request` into UI dialogs.
// `@codepilot/core` imports are `import type` (build-time erased) so no Node
// code reaches the bundle; runtime import is the dep-free `@codepilot/protocol/rpc`.

import { Peer, RpcError, PROTOCOL_VERSION } from "@codepilot/protocol/rpc";
import type {
  AgentMode,
  Event,
  ImageAttachment,
  PromptFile,
  PermissionDecision,
  PermissionMode,
  PluginCapabilityReport,
  QuestionAnswers,
  SessionSummary,
} from "@codepilot/core";
import type {
  EventParams,
  InitializeResult,
  PermissionRequestParams,
  QuestionRequestParams,
  DiagnosticsRequestParams,
  DiagnosticsRequestResult,
  SessionResumeResult,
} from "@codepilot/protocol";

import { BrowserWebSocketTransport, waitForOpen } from "./transport.js";
import { buildUrl } from "./clientErrors.js";
import * as clientConfig from "./clientConfig.js";
import * as clientPlugins from "./clientPlugins.js";
import * as clientSession from "./clientSession.js";
import * as clientWorkspace from "./clientWorkspace.js";
import type {
  ClientCallbacks,
  ClientRpcHost,
  ConfigProviderPreset,
  ConfigProviderRedacted,
  ConfigSnapshot,
  ConnectOptions,
  ContextReport,
  CustomSearchTemplateInfo,
  OpenedTransport,
  RemoteModelInfo,
  SessionOptions,
  TransportOpener,
  WorkspaceChangedParams,
} from "./clientTypes.js";

// Single source of truth: the protocol version comes from the dependency-free
// @codepilot/protocol/rpc module (same constant the server advertises), not a
// local literal that could drift on a version bump. Re-exported for callers.
export { PROTOCOL_VERSION };
export * from "./clientTypes.js";
export * from "./clientErrors.js";

export class CodepilotClient {
  private peer: Peer | null = null;
  private transport: OpenedTransport | null = null;
  private capabilities: InitializeResult["capabilities"] | null = null;
  private lastConnect: { open: TransportOpener; opts: SessionOptions } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
 /** UI-level workspace-change sink (the panel swaps this per render). */
  private workspaceChangedHandler: ((p: WorkspaceChangedParams) => void) | null = null;
  private mcpOauthRequiredHandler: ((p: { name: string; url: string }) => void) | null = null;
  private terminalDataHandler:
    | ((p: { terminalId: string; data: string }) => void)
    | null = null;
  private terminalExitHandler:
    | ((p: { terminalId: string; exitCode: number }) => void)
    | null = null;

  setWorkspaceChangedHandler(handler: ((p: WorkspaceChangedParams) => void) | null): void {
    this.workspaceChangedHandler = handler;
  }

  setMcpOauthRequiredHandler(
    handler: ((p: { name: string; url: string }) => void) | null,
  ): void {
    this.mcpOauthRequiredHandler = handler;
  }

  setTerminalHandlers(handlers: {
    onData?: ((p: { terminalId: string; data: string }) => void) | null;
    onExit?: ((p: { terminalId: string; exitCode: number }) => void) | null;
  } | null): void {
    this.terminalDataHandler = handlers?.onData ?? null;
    this.terminalExitHandler = handlers?.onExit ?? null;
  }

  constructor(private readonly callbacks: ClientCallbacks) {}

  get connected(): boolean {
    return this.peer !== null;
  }

  get tools(): string[] {
    return this.capabilities?.tools ?? [];
  }

  get modes(): AgentMode[] {
    return this.capabilities?.modes ?? ["chat", "plan", "agent"];
  }

  /** Phone QR remote-control (scoped grant). */
  isRemoteControl(): boolean {
    return this.capabilities?.remoteControl === true;
  }

  /** Whether the UI may offer “open / add workspace” (native folder picker). */
  canPickWorkspace(): boolean {
    if (this.capabilities?.remoteControl === true) return false;
    if (this.capabilities?.workspacePick === false) return false;
    return true;
  }

 /** Connect over WebSocket to `codepilot serve --web`. */
  async connect(opts: ConnectOptions): Promise<InitializeResult> {
    const { url, token } = opts;
    return this.connectTransport(async () => {
      const socket = new WebSocket(buildUrl(url, token));
      await waitForOpen(socket);
      const transport = new BrowserWebSocketTransport(socket);
      return {
        transport,
        close: () => transport.close(),
        onClose: (listener) => socket.addEventListener("close", listener),
      };
    }, { cwd: opts.cwd, permissionMode: opts.permissionMode });
  }

 /**
 * Connect through any transport (the IDE host bridge, a test double). The
 * opener is kept and reused for automatic reconnects.
 */
  async connectTransport(open: TransportOpener, opts: SessionOptions): Promise<InitializeResult> {
    this.manualDisconnect = false;
    this.lastConnect = { open, opts: { ...opts } };
    this.clearReconnectTimer();
    await this.disconnect({ markManual: false });
    const opened = await open();
    const peer = new Peer({ transport: opened.transport, debug: false });
    this.transport = opened;
    this.peer = peer;

    peer.onNotification<EventParams>("event", (p) => {
      this.callbacks.onEvent(p.sessionId, p.event);
    });
 // `session/usage` duplicates the `usage` event; the reducer already sums
 // those, so acknowledging it here just keeps Peer from logging a warning.
    peer.onNotification("session/usage", () => {});
    peer.onNotification<WorkspaceChangedParams>("workspace/changed", (p) => {
      this.workspaceChangedHandler?.(p);
      this.callbacks.onWorkspaceChanged?.(p);
    });
    peer.onNotification<{ name: string; url: string }>("mcp/oauth-required", (p) => {
      this.mcpOauthRequiredHandler?.(p);
      this.callbacks.onMcpOauthRequired?.(p);
    });
    peer.onNotification<{ terminalId: string; data: string }>("terminal/data", (p) => {
      this.terminalDataHandler?.(p);
    });
    peer.onNotification<{ terminalId: string; exitCode: number }>("terminal/exit", (p) => {
      this.terminalExitHandler?.(p);
    });
    peer.onNotification<{ requestId: string }>("permission/resolved", (p) => {
      this.callbacks.onPromptResolved?.("permission", p.requestId);
    });
    peer.onNotification<{ requestId: string }>("question/resolved", (p) => {
      this.callbacks.onPromptResolved?.("question", p.requestId);
    });
    peer.onRequest<PermissionRequestParams, Record<string, never>>(
      "permission/request",
      (p) => {
        this.callbacks.onPermission({
          requestId: p.requestId,
          sessionId: p.sessionId,
          toolName: p.toolName,
          input: p.input,
          reason: p.reason,
          ...(p.sandboxExpand ? { sandboxExpand: p.sandboxExpand } : {}),
          ...(p.sandboxEscalation ? { sandboxEscalation: true as const } : {}),
          ...(p.preview ? { preview: p.preview } : {}),
        });
 // The server waits for a separate `permission/respond` call, so the
 // reverse request itself is answered immediately.
        return {};
      },
    );
    peer.onRequest<QuestionRequestParams, Record<string, never>>(
      "question/request",
      (p) => {
        this.callbacks.onQuestion({
          requestId: p.requestId,
          sessionId: p.sessionId,
          questions: p.questions,
        });
        return {};
      },
    );
    peer.onRequest<DiagnosticsRequestParams, DiagnosticsRequestResult>(
      "diagnostics/request",
      async (p) => {
        // Diagnostics reply inline (unlike permission/question). A browser has
        // no language server, so without a host-provided callback we report it
        // unavailable and let the tool fall back to running the checker in bash.
        if (this.callbacks.onDiagnosticsRequest) {
          return this.callbacks.onDiagnosticsRequest(p);
        }
        return { unavailable: true };
      },
    );

    void peer.loopDone.then(
      () => { if (this.peer === peer) this.handleClosed("transport ended"); },
      () => { if (this.peer === peer) this.handleClosed("transport ended"); },
    );
    opened.onClose(() => {
      if (this.peer === peer) this.handleClosed("socket closed");
    });

    const init = await peer.request<unknown, InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? "ask",
      clientInfo: { name: opts.clientName ?? "codepilot-web", version: "2.0.0" },
    });
    this.capabilities = init.capabilities;
    return init;
  }

  async disconnect(opts: { markManual?: boolean } = {}): Promise<void> {
    if (opts.markManual !== false) this.manualDisconnect = true;
    this.clearReconnectTimer();
    const peer = this.peer;
    const transport = this.transport;
    this.peer = null;
    this.transport = null;
    this.capabilities = null;
    if (peer) await peer.close().catch(() => {});
    transport?.close();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || !this.lastConnect || this.reconnectTimer !== null) return;
    this.reconnectAttempt++;
    const delayMs = Math.min(1000 * 2 ** Math.min(this.reconnectAttempt - 1, 4), 15000);
    this.callbacks.onReconnecting?.(this.reconnectAttempt, delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs);
  }

  private async reconnect(): Promise<void> {
    const last = this.lastConnect;
    if (!last || this.manualDisconnect) return;
 // `connectTransport` remembers these options again and clears stale
 // state; if it throws, the failure callbacks below keep the retry loop
 // alive.
    try {
      const init = await this.connectTransport(last.open, last.opts);
      this.reconnectAttempt = 0;
      this.callbacks.onReconnected?.(init);
    } catch {
      this.scheduleReconnect();
    }
  }

 // ----- protocol methods -----

  private rpcHost(): ClientRpcHost {
    return { call: (method, params) => this.call(method, params) };
  }

  async newSession(params: {
    cwd?: string;
    model?: string;
    agentMode?: AgentMode;
    systemPromptExtra?: string;
  }): Promise<string> {
    return clientSession.newSession(this.rpcHost(), params);
  }

  async resumeSession(
    sessionId: string,
    opts?: { readOnly?: boolean; historyLimit?: number },
  ): Promise<SessionResumeResult> {
    return clientSession.resumeSession(this.rpcHost(), sessionId, opts);
  }

  /** Older history page for a resumed session (`before` from a prior resume). */
  async sessionHistory(
    sessionId: string,
    before: number,
    limit?: number,
  ): Promise<{ events: Event[]; historyTruncated: boolean; historyBefore?: number }> {
    return clientSession.sessionHistory(this.rpcHost(), sessionId, before, limit);
  }

  async listWorkspace(path = ".", cwd?: string): Promise<{ path: string; entries: Array<{ name: string; path: string; kind: "file" | "directory"; size?: number }> }> {
    return clientWorkspace.listWorkspace(this.rpcHost(), path, cwd);
  }

 /** Native folder dialog on the serve host (may return null if cancelled). */
  async pickFolder(): Promise<{ path: string | null; supported: boolean }> {
    return clientWorkspace.pickFolder(this.rpcHost());
  }

 /** Browse absolute directories on the serve host (folder picker UI). */
  async browseWorkspace(path?: string): Promise<{
    path: string;
    parent?: string;
    entries: Array<{ name: string; path: string; kind: "file" | "directory" }>;
    roots: Array<{ label: string; path: string }>;
  }> {
    return clientWorkspace.browseWorkspace(this.rpcHost(), path);
  }

  async workspaceStat(path: string, cwd?: string): Promise<{ path: string; exists: boolean; size: number; hash: string; modifiedAt?: number }> {
    return clientWorkspace.workspaceStat(this.rpcHost(), path, cwd);
  }

  /** Manual compaction (`/compact`): summarise now, keep going on the task. */
  async sessionCompact(sessionId: string, focus?: string): Promise<{ ok: true }> {
    return clientSession.sessionCompact(this.rpcHost(), sessionId, focus);
  }

  /** Task boundary (`/clear`): archive context, continue with a clean slate. */
  async sessionClearContext(sessionId: string, reason?: string): Promise<{ cleared: boolean }> {
    return clientSession.sessionClearContext(this.rpcHost(), sessionId, reason);
  }

  /** Context-window usage report for the live session: totals + a semantic
   * breakdown (system prompt, skills, tool/MCP schemas, conversation,
   * sub-agents). Used by the context-usage panel. */
  async sessionContextReport(sessionId: string): Promise<ContextReport> {
    return clientSession.sessionContextReport(this.rpcHost(), sessionId);
  }

  /** Exact prompt token count via the server's provider count-tokens API,
   * returned when `context.preciseCount: "on-demand"` and the provider supports
   * it; `null` otherwise. Opt-in only — never a hot path. */
  async sessionContextCountPrecise(
    sessionId: string,
  ): Promise<{ inputTokens: number } | null> {
    return clientSession.sessionContextCountPrecise(this.rpcHost(), sessionId);
  }

  /** List slash commands for the `/` menu (shared built-ins + md commands).
   * `kind` tells local actions ("local") apart from prompt-expanding markdown
   * commands ("prompt") without a hard-coded name list. */
  async commandsList(cwd?: string): Promise<{
    commands: Array<{
      name: string;
      description: string;
      argumentHint?: string;
      source: "builtin" | "project" | "user" | "plugin" | "mcp";
      kind: "local" | "prompt";
    }>;
    warnings: string[];
  }> {
    return clientWorkspace.commandsList(this.rpcHost(), cwd);
  }

  async commandsExpand(
    name: string,
    args?: string,
    cwd?: string,
  ): Promise<{
    prompt: string;
    model?: string;
    allowedTools?: string[];
    source: "builtin" | "project" | "user" | "plugin" | "mcp";
  }> {
    return clientWorkspace.commandsExpand(this.rpcHost(), name, args, cwd);
  }

  /** `@`-mention completion candidates (file/dir/mcp/git/skill). */
  async workspaceComplete(
    query: string,
    opts: { kinds?: Array<"file" | "dir" | "mcp" | "git" | "skill">; maxResults?: number; cwd?: string } = {},
  ): Promise<{
    candidates: Array<{ kind: "file" | "dir" | "mcp" | "git" | "skill"; value: string; label: string; detail?: string }>;
    truncated?: boolean;
  }> {
    return clientWorkspace.workspaceComplete(this.rpcHost(), query, opts);
  }

 /** Subscribe to debounced disk-change notifications for a directory. */
  async watchWorkspace(path = ".", cwd?: string): Promise<{ watching: boolean; path: string }> {
    return clientWorkspace.watchWorkspace(this.rpcHost(), path, cwd);
  }

  async gitDiff(path?: string, staged = false, cwd?: string): Promise<{ path?: string; diff: string; truncated: boolean }> {
    return clientWorkspace.gitDiff(this.rpcHost(), path, staged, cwd);
  }

  async gitStatus(cwd?: string): Promise<{ branch: string; files: Array<{ path: string; index: string; worktree: string; status: string }> }> {
    return clientWorkspace.gitStatus(this.rpcHost(), cwd);
  }

  async gitBranches(cwd?: string): Promise<{ current: string; branches: Array<{ name: string; current: boolean; upstream?: string; ahead?: number; behind?: number }>; tags: string[]; detached: boolean }> {
    return clientWorkspace.gitBranches(this.rpcHost(), cwd);
  }

  async gitInit(cwd?: string): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitInit(this.rpcHost(), cwd);
  }

  async gitStage(paths?: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitStage(this.rpcHost(), paths, cwd);
  }

  async gitUnstage(paths?: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitUnstage(this.rpcHost(), paths, cwd);
  }

  async gitCommit(message: string, all = false, cwd?: string): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitCommit(this.rpcHost(), message, all, cwd);
  }

  async gitPush(opts: { remote?: string; branch?: string; setUpstream?: boolean; cwd?: string } = {}): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitPush(this.rpcHost(), opts);
  }

  async gitPull(opts: { remote?: string; branch?: string; cwd?: string } = {}): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitPull(this.rpcHost(), opts);
  }

  async gitFetch(cwd?: string): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitFetch(this.rpcHost(), cwd);
  }

  async gitCheckout(branch: string, create = false, cwd?: string): Promise<{ ok: boolean; output: string }> {
    return clientWorkspace.gitCheckout(this.rpcHost(), branch, create, cwd);
  }

  async gitCommitMessage(cwd?: string, sessionId?: string): Promise<{ message: string }> {
    return clientWorkspace.gitCommitMessage(this.rpcHost(), cwd, sessionId);
  }

  async writeWorkspace(path: string, content: string, expectedSize?: number, expectedHash?: string, cwd?: string): Promise<{ path: string; size: number; hash: string }> {
    return clientWorkspace.writeWorkspace(this.rpcHost(), path, content, expectedSize, expectedHash, cwd);
  }

  async searchWorkspace(query: string, path = ".", maxResults = 100, cwd?: string): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    return clientWorkspace.searchWorkspace(this.rpcHost(), query, path, maxResults, cwd);
  }

  async readWorkspace(path: string, cwd?: string): Promise<{
    path: string;
    content: string;
    size: number;
    hash: string;
    truncated: boolean;
    encoding?: "utf8" | "base64";
    mediaType?: string;
  }> {
    return clientWorkspace.readWorkspace(this.rpcHost(), path, cwd);
  }

  /** Resolve a (bare/relative) path to an absolute one the host can open,
   * using the server's workspace basename fallback. */
  async resolveWorkspace(path: string, cwd?: string): Promise<{
    path: string;
    absolute: string;
    exists: boolean;
  }> {
    return clientWorkspace.resolveWorkspace(this.rpcHost(), path, cwd);
  }

  /** Engine (CLI/daemon) update channel — not the IDE plugin / VSIX. */
  async checkEngineUpdate(): Promise<{
    engine: {
      channel: "engine";
      current: string;
      latest: string | null;
      available: boolean;
      tag?: string;
      installRoot: string | null;
      canAutoApply: boolean;
    };
  }> {
    return clientPlugins.checkEngineUpdate(this.rpcHost());
  }

  async applyEngineUpdate(): Promise<{
    applied: boolean;
    version: string;
    message?: string;
  }> {
    return clientPlugins.applyEngineUpdate(this.rpcHost());
  }

  async mintRemotePairing(opts: {
    serveUrl: string;
    cwd?: string;
    cwds?: string[];
    sessionId?: string;
  }): Promise<{
    code: string;
    url: string;
    qrPayload: string;
    expiresAt: number;
    qrDataUrl: string;
    rewritten?: boolean;
    warning?: string;
    lanIp?: string;
  }> {
    return clientPlugins.mintRemotePairing(this.rpcHost(), opts);
  }

  async listMcpMarkets(): Promise<{
    markets: Array<{ id: string; name: string; description: string; url: string }>;
  }> {
    return clientPlugins.listMcpMarkets(this.rpcHost());
  }

  async installMcpJson(json: string, name?: string): Promise<{
    mcpConfigPath: string;
    names: string[];
    message: string;
  }> {
    return clientPlugins.installMcpJson(this.rpcHost(), json, name);
  }

  async listInstalledMcp(): Promise<{
    servers: Array<{
      name: string;
      enabled: boolean;
      summary: string;
      command?: string;
      url?: string;
      type?: string;
    }>;
  }> {
    return clientPlugins.listInstalledMcp(this.rpcHost());
  }

  async setMcpEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean; message: string }> {
    return clientPlugins.setMcpEnabled(this.rpcHost(), name, enabled);
  }

  async inspectMcp(name: string): Promise<{
    name: string;
    connected: boolean;
    tools: Array<{ name: string; description: string }>;
    resources: Array<{ uri: string; name: string; description?: string }>;
    prompts: Array<{ name: string; description?: string }>;
    error?: string;
    needsAuth?: boolean;
  }> {
    return clientPlugins.inspectMcp(this.rpcHost(), name);
  }

  async startMcpOauth(name: string): Promise<{
    state: "idle" | "pending" | "authorized" | "error";
    url?: string;
    error?: string;
  }> {
    return clientPlugins.startMcpOauth(this.rpcHost(), name);
  }

  async mcpOauthStatus(name: string): Promise<{
    state: "idle" | "pending" | "authorized" | "error";
    url?: string;
    error?: string;
  }> {
    return clientPlugins.mcpOauthStatus(this.rpcHost(), name);
  }

  async cancelMcpOauth(name: string): Promise<{ state: "idle" | "pending" | "authorized" | "error" }> {
    return clientPlugins.cancelMcpOauth(this.rpcHost(), name);
  }

  async listPluginMarket(query?: string): Promise<{
    plugins: Array<{
      name: string;
      description: string;
      source: string;
      version?: string;
      author?: string;
      tags?: string[];
    }>;
    describe: Record<string, string>;
  }> {
    return clientPlugins.listPluginMarket(this.rpcHost(), query);
  }

  async listInstalledPlugins(): Promise<{
    plugins: Array<{
      name: string;
      description: string;
      version: string;
      source: string;
      enabled: boolean;
      /** False when the plugin's hooks / MCP servers / runtime await approval. */
      trusted?: boolean;
    }>;
  }> {
    return clientPlugins.listInstalledPlugins(this.rpcHost());
  }

  async trustPlugin(name: string): Promise<{ trusted: boolean }> {
    return clientPlugins.trustPlugin(this.rpcHost(), name);
  }

  async inspectPlugin(source: string): Promise<PluginCapabilityReport> {
    return clientPlugins.inspectPlugin(this.rpcHost(), source);
  }

  async installPlugin(source: string, force?: boolean): Promise<{ name: string; path: string }> {
    return clientPlugins.installPlugin(this.rpcHost(), source, force);
  }

  async uninstallPlugin(name: string): Promise<{ removed: boolean }> {
    return clientPlugins.uninstallPlugin(this.rpcHost(), name);
  }

  async revokeAllRemote(): Promise<{ revoked: boolean }> {
    return clientPlugins.revokeAllRemote(this.rpcHost());
  }

  async initWorkspace(opts?: {
    force?: boolean;
    filename?: "AGENTS.md" | "CODEPILOT.md";
  }): Promise<{ path: string; created: boolean; skipped: boolean }> {
    return clientWorkspace.initWorkspace(this.rpcHost(), opts);
  }

  async undoSession(sessionId: string): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    return clientSession.undoSession(this.rpcHost(), sessionId);
  }

  async redoSession(sessionId: string): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    return clientSession.redoSession(this.rpcHost(), sessionId);
  }

  async rewindTargets(sessionId: string): Promise<Array<{ messageId: string; text: string; ts?: number }>> {
    return clientSession.rewindTargets(this.rpcHost(), sessionId);
  }

  async rewindSession(
    sessionId: string,
    opts?: { messageId?: string; files?: boolean },
  ): Promise<{ messageId: string; text: string; turns: number; restored: string[]; deleted: string[] }> {
    return clientSession.rewindSession(this.rpcHost(), sessionId, opts);
  }

  async gcSessionArtifacts(
    sessionId: string,
    dryRun?: boolean,
  ): Promise<{ removed: number; bytesReclaimed: number; scanned: number; referenced: number }> {
    return clientSession.gcSessionArtifacts(this.rpcHost(), sessionId, dryRun);
  }

  async exportSessionTranscript(
    sessionId: string,
    format?: "markdown" | "jsonl",
  ): Promise<{ format: "markdown" | "jsonl"; body: string; suggestedName: string }> {
    return clientSession.exportSessionTranscript(this.rpcHost(), sessionId, format);
  }

  async startSessionGoal(
    sessionId: string,
    objective: string,
    maxRounds?: number,
  ): Promise<{ accepted: true; running: boolean }> {
    return clientSession.startSessionGoal(this.rpcHost(), sessionId, objective, maxRounds);
  }

  async setPermissionMode(
    sessionId: string,
    mode: import("@codepilot/core").PermissionMode,
  ): Promise<{ mode: import("@codepilot/core").PermissionMode }> {
    return clientSession.setPermissionMode(this.rpcHost(), sessionId, mode);
  }

  async setPreset(
    sessionId: string,
    preset: import("@codepilot/core").PermissionPresetName,
  ): Promise<{
    preset: import("@codepilot/core").PermissionPresetName;
    permissionMode: import("@codepilot/core").PermissionMode;
    sandbox: { mode: string; unavailable?: boolean; backend?: string };
  }> {
    return clientSession.setPreset(this.rpcHost(), sessionId, preset);
  }

  async describeSessionHooks(sessionId: string): Promise<{ text: string }> {
    return clientSession.describeSessionHooks(this.rpcHost(), sessionId);
  }

  async describeSessionAgents(opts?: {
    sessionId?: string;
    cwd?: string;
  }): Promise<{ text: string }> {
    return clientSession.describeSessionAgents(this.rpcHost(), opts);
  }

  async listConnectors(opts?: {
    q?: string;
    tab?: "all" | "installed" | "available";
    offset?: number;
    limit?: number;
  }): Promise<{
    connectors: unknown[];
    total: number;
    offset: number;
    limit: number;
  }> {
    return clientPlugins.listConnectors(this.rpcHost(), opts);
  }

  async installConnector(
    connectorId: string,
    values: Record<string, string>,
  ): Promise<{ mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }> {
    return clientPlugins.installConnector(this.rpcHost(), connectorId, values);
  }

  async updateConnector(
    connectorId: string,
    values: Record<string, string>,
  ): Promise<{ mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }> {
    return clientPlugins.updateConnector(this.rpcHost(), connectorId, values);
  }

  async setConnectorEnabled(
    connectorId: string,
    enabled: boolean,
  ): Promise<{ connectorId: string; enabled: boolean; message: string }> {
    return clientPlugins.setConnectorEnabled(this.rpcHost(), connectorId, enabled);
  }

  async listSkills(opts?: {
    q?: string;
    tab?: "all" | "installed" | "available";
    offset?: number;
    limit?: number;
  }): Promise<{
    skills: Array<{
      name: string;
      description: string;
      state: "installed" | "available";
      enabled: boolean;
      source?: string;
      connectorId?: string;
      when?: string;
    }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    return clientPlugins.listSkills(this.rpcHost(), opts);
  }

  async installSkill(connectorId: string): Promise<{ skillPath: string; message: string }> {
    return clientPlugins.installSkill(this.rpcHost(), connectorId);
  }

  async installSkillArchive(
    filename: string,
    dataBase64: string,
  ): Promise<{
    names: string[];
    replaced: string[];
    skillPaths: string[];
    message: string;
  }> {
    return clientPlugins.installSkillArchive(this.rpcHost(), filename, dataBase64);
  }

  /**
   * Install a skill from a git URL, remote archive URL, or local path (the
   * same source vector as plugin install). Complements the connector-catalog
   * and zip-upload paths with a "paste a repo/URL" entry.
   */
  async installSkillSource(source: string): Promise<{
    names: string[];
    replaced: string[];
    skillPaths: string[];
    message: string;
  }> {
    return clientPlugins.installSkillSource(this.rpcHost(), source);
  }

  async setSkillEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean; message: string }> {
    return clientPlugins.setSkillEnabled(this.rpcHost(), name, enabled);
  }

  async getSkillContent(name: string): Promise<{
    name: string;
    markdown: string;
    path: string;
    source?: string;
    editablePath: string;
    readOnlySource: boolean;
    rootDir?: string;
    files?: string[];
  }> {
    return clientPlugins.getSkillContent(this.rpcHost(), name);
  }

  async getSkillFile(
    name: string,
    relativePath: string,
  ): Promise<{
    name: string;
    relativePath: string;
    content: string;
    rootDir: string;
    readOnlySource: boolean;
  }> {
    return clientPlugins.getSkillFile(this.rpcHost(), name, relativePath);
  }

  async saveSkillContent(
    name: string,
    markdown: string,
  ): Promise<{ name: string; path: string; message: string }> {
    return clientPlugins.saveSkillContent(this.rpcHost(), name, markdown);
  }

  async saveSkillFile(
    name: string,
    relativePath: string,
    content: string,
  ): Promise<{ name: string; path: string; message: string }> {
    return clientPlugins.saveSkillFile(this.rpcHost(), name, relativePath, content);
  }

  async skillCreatorPrompt(): Promise<{ prompt: string }> {
    return clientPlugins.skillCreatorPrompt(this.rpcHost());
  }

  async listScheduledTasks(): Promise<{ tasks: unknown[] }> {
    return clientPlugins.listScheduledTasks(this.rpcHost());
  }

  async addScheduledTask(task: {
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
  }): Promise<{ task: unknown }> {
    return clientPlugins.addScheduledTask(this.rpcHost(), task);
  }

  async updateScheduledTask(
    id: string,
    patch: {
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
  ): Promise<{ task: unknown }> {
    return clientPlugins.updateScheduledTask(this.rpcHost(), id, patch);
  }

  async removeScheduledTask(id: string): Promise<{ removed: boolean }> {
    return clientPlugins.removeScheduledTask(this.rpcHost(), id);
  }

  async listTerminalShells(): Promise<{
    platform: "darwin" | "linux" | "win32" | "other";
    shells: Array<{ id: string; path: string; label: string }>;
  }> {
    return clientSession.listTerminalShells(this.rpcHost());
  }

  async openTerminal(opts: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ terminalId: string; shell: string }> {
    return clientSession.openTerminal(this.rpcHost(), opts);
  }

  async writeTerminal(terminalId: string, data: string): Promise<void> {
    return clientSession.writeTerminal(this.rpcHost(), terminalId, data);
  }

  async resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    return clientSession.resizeTerminal(this.rpcHost(), terminalId, cols, rows);
  }

  async closeTerminal(terminalId: string): Promise<void> {
    return clientSession.closeTerminal(this.rpcHost(), terminalId);
  }

 /**
 * List sessions. Pass `cwd` to filter; omit to return every session
 * (client groups them by workspace).
 */
  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    return clientSession.listSessions(this.rpcHost(), cwd);
  }

 /**
 * Re-run `initialize` with a new default cwd (workspace focus) without
 * dropping the WebSocket. Used when the user opens / switches folders.
 */
  async setActiveCwd(cwd: string): Promise<void> {
    const peer = this.peer;
    if (!peer) throw new RpcError(-32603, "not connected");
    const last = this.lastConnect;
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd,
      permissionMode: last?.opts.permissionMode ?? "ask",
      clientInfo: {
        name: last?.opts.clientName ?? "codepilot-web",
        version: "2.0.0",
      },
    });
    if (last) last.opts.cwd = cwd;
  }

  /** Pin / unpin a session (pin is one-per-workspace, enforced server-side). */
  async pinSession(sessionId: string, pinned: boolean): Promise<void> {
    return clientSession.pinSession(this.rpcHost(), sessionId, pinned);
  }

  /** Archive / unarchive a session (archived sessions are hidden by default). */
  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    return clientSession.archiveSession(this.rpcHost(), sessionId, archived);
  }

  async send(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    delivery?: "auto" | "queue" | "steer",
  ): Promise<{ delivery: "started" | "queued" | "steered" }> {
    return clientSession.send(this.rpcHost(), sessionId, text, images, files, delivery);
  }

  async removeFollowUp(sessionId: string, id: string): Promise<void> {
    return clientSession.removeFollowUp(this.rpcHost(), sessionId, id);
  }

  async updateFollowUp(sessionId: string, id: string, text: string): Promise<void> {
    return clientSession.updateFollowUp(this.rpcHost(), sessionId, id, text);
  }

  async sendFollowUpNow(
    sessionId: string,
    id: string,
  ): Promise<{ delivery: "steered" | "started" | "missing" }> {
    return clientSession.sendFollowUpNow(this.rpcHost(), sessionId, id);
  }

  /**
   * Resume the last turn after it ended in an error — re-engage the model where
   * it stopped. `noop` means nothing to resume; the caller should re-send the
   * last prompt.
   */
  async resumeTurn(
    sessionId: string,
  ): Promise<{ delivery: "started" | "queued" | "noop" }> {
    return clientSession.resumeTurn(this.rpcHost(), sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    return clientSession.cancel(this.rpcHost(), sessionId);
  }

  async setMode(sessionId: string, mode: AgentMode): Promise<void> {
    return clientSession.setMode(this.rpcHost(), sessionId, mode);
  }

  async setModel(
    sessionId: string,
    model: string,
    providerId?: string,
    reasoningEffort?: "low" | "medium" | "high" | null,
  ): Promise<{
    model: string;
    providerId?: string;
    reasoningEffort?: "low" | "medium" | "high";
  }> {
    return clientSession.setModel(this.rpcHost(), sessionId, model, providerId, reasoningEffort);
  }

  async getEndpoint(sessionId: string): Promise<{
    model: string;
    providerId?: string;
    provider?: string;
    baseURL?: string;
    reasoningEffort?: "low" | "medium" | "high";
  }> {
    return clientSession.getEndpoint(this.rpcHost(), sessionId);
  }

  async getConfig(cwd?: string): Promise<ConfigSnapshot> {
    return clientConfig.getConfig(this.rpcHost(), cwd);
  }

  async setImageGen(patch: {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    enabled?: boolean;
  }): Promise<{ imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean } }> {
    return clientConfig.setImageGen(this.rpcHost(), patch);
  }

  /**
   * Set the web_search backend. Persists to the shared user config, so every
   * client following the same daemon inherits it. An empty apiKey keeps the
   * stored one; `custom` carries a full HTTP template.
   */
  async setWebSearch(patch: {
    provider?: "duckduckgo" | "brave" | "serper" | "google" | "custom";
    apiKey?: string;
    cx?: string;
    engineId?: string | null;
    env?: Record<string, string> | null;
    custom?: CustomSearchTemplateInfo | null;
  }): Promise<{
    webSearch: {
      provider?: string;
      hasApiKey: boolean;
      customUrl?: string;
      engineId?: string;
      custom?: CustomSearchTemplateInfo;
      env?: Record<string, string>;
    };
  }> {
    return clientConfig.setWebSearch(this.rpcHost(), patch);
  }

  /** Stamp the first-run marker in the shared config (idempotent). */
  async setOnboarded(): Promise<{ onboardedAt: string }> {
    return clientConfig.setOnboarded(this.rpcHost());
  }

  /**
   * Change the OS sandbox mode. Persists to the user config (next session
   * inherits it); pass `sessionId` to also hot-apply it to that live session so
   * the switch takes effect from the next bash command.
   */
  async setSandbox(patch: {
    mode: "off" | "workspace-write" | "read-only";
    sessionId?: string;
  }): Promise<{
    sandbox: {
      mode: "off" | "workspace-write" | "read-only";
      unavailable: boolean;
      backend: string;
      reason?: { backend: string; platform: string; hint: string };
    };
  }> {
    return clientConfig.setSandbox(this.rpcHost(), patch);
  }

  async upsertProvider(
    id: string,
    preset: ConfigProviderPreset,
    opts?: { setActive?: boolean; sessionId?: string },
  ): Promise<{ providers: Record<string, ConfigProviderRedacted> }> {
    return clientConfig.upsertProvider(this.rpcHost(), id, preset, opts);
  }

  async deleteProvider(id: string): Promise<{ providers: Record<string, ConfigProviderRedacted> }> {
    return clientConfig.deleteProvider(this.rpcHost(), id);
  }

  async setActiveProvider(
    providerId: string,
    opts?: { model?: string; sessionId?: string; persist?: boolean },
  ): Promise<{ model: string; providerId: string }> {
    return clientConfig.setActiveProvider(this.rpcHost(), providerId, opts);
  }

  async listRemoteModels(opts: {
    providerId?: string;
    provider?: "anthropic" | "openai" | "copilot" | "gemini" | "azure";
    baseURL?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }): Promise<RemoteModelInfo[]> {
    return clientConfig.listRemoteModels(this.rpcHost(), opts);
  }

  async fork(sessionId: string, atEventIndex?: number): Promise<string> {
    return clientSession.fork(this.rpcHost(), sessionId, atEventIndex);
  }

  async respondPermission(
    requestId: string,
    decision: PermissionDecision | "abort",
    feedback?: string,
  ): Promise<void> {
    return clientSession.respondPermission(this.rpcHost(), requestId, decision, feedback);
  }

  /** Persisted permission rules for a scope (repo default). */
  async listPermissions(
    sessionId: string,
    scope: "repo" | "user" = "repo",
  ): Promise<{ scope: "repo" | "user"; allow: string[]; ask: string[]; deny: string[] }> {
    return clientSession.listPermissions(this.rpcHost(), sessionId, scope);
  }

  /** Persist a permission rule and hot-apply it to the live session. */
  async addPermission(
    sessionId: string,
    rule: string,
    effect: "allow" | "ask" | "deny",
    scope: "repo" | "user" = "repo",
  ): Promise<{ path: string }> {
    return clientSession.addPermission(this.rpcHost(), sessionId, rule, effect, scope);
  }

  /** Delete a persisted permission rule and hot-apply the removal. */
  async removePermission(
    sessionId: string,
    rule: string,
    effect: "allow" | "ask" | "deny",
    scope: "repo" | "user" = "repo",
  ): Promise<{ removed: boolean }> {
    return clientSession.removePermission(this.rpcHost(), sessionId, rule, effect, scope);
  }

  async respondQuestion(
    requestId: string,
    answers: QuestionAnswers,
  ): Promise<void> {
    return clientSession.respondQuestion(this.rpcHost(), requestId, answers);
  }

  private async call<R>(method: string, params?: unknown): Promise<R> {
    const peer = this.peer;
    if (!peer) throw new RpcError(-32603, "not connected");
    return peer.request<unknown, R>(method, params);
  }

  private handleClosed(reason?: string): void {
    if (!this.peer && !this.transport) return;
    this.peer = null;
    this.transport = null;
    this.capabilities = null;
    this.callbacks.onClose(reason);
    this.scheduleReconnect();
  }
}
