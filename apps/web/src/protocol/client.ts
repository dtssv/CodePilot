// Browser-side protocol client.
//
// Wraps `Peer` with the CodePilot method surface and turns the two
// server-initiated requests (`permission/request`, `question/request`) into
// callbacks the UI can render as dialogs.
//
// Everything imported from `@codepilot/core` here is `import type` on
// purpose: those types are erased at build time, so no Node-only code reaches
// the bundle. The runtime import is `@codepilot/protocol/rpc`, which has no
// dependencies at all.

import { Peer, RpcError, PROTOCOL_VERSION, type RpcTransport } from "@codepilot/protocol/rpc";
import type {
  AgentMode,
  Event,
  ImageAttachment,
  PromptFile,
  PermissionDecision,
  PermissionMode,
  QuestionAnswers,
  QuestionSpec,
  SessionSummary,
} from "@codepilot/core";
import type {
  EventParams,
  InitializeResult,
  PermissionRequestParams,
  QuestionRequestParams,
  SessionResumeResult,
} from "@codepilot/protocol";

import { BrowserWebSocketTransport, waitForOpen } from "./transport.js";

// Single source of truth: the protocol version comes from the dependency-free
// @codepilot/protocol/rpc module (same constant the server advertises), not a
// local literal that could drift on a version bump. Re-exported for callers.
export { PROTOCOL_VERSION };

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  reason: string;
 /** Out-of-sandbox write: allow adds this folder (always also persists). */
  sandboxExpand?: { path: string };
}

/** Context-window usage report (mirrors core Session.contextReport). */
export interface ContextReport {
  totalTokens: number;
  window: number;
  triggerThreshold: number;
  triggerFraction: number;
  usagePercent: number;
  autoCompactEnabled: boolean;
  byEventType: { type: string; tokens: number; count: number }[];
  byCategory?: { category: string; tokens: number }[];
  topFileReads: { path: string; reads: number; tokens: number }[];
  duplicateReads: { path: string; reads: number }[];
}

export interface PendingQuestion {
  requestId: string;
  sessionId: string;
  questions: QuestionSpec[];
}

export interface ClientCallbacks {
  onEvent(sessionId: string, event: Event): void;
  onPermission(req: PendingPermission): void;
  onQuestion(req: PendingQuestion): void;
 /** Another client following the session answered this request. */
  onPromptResolved?(kind: "permission" | "question", requestId: string): void;
 /** Transport went away — the UI should offer to reconnect. */
  onClose(reason?: string): void;
 /** Automatic reconnect succeeded after a transport drop. */
  onReconnected?(init: InitializeResult): void;
 /** Automatic reconnect is being attempted. */
  onReconnecting?(attempt: number, delayMs: number): void;
  /** A watched workspace directory changed on disk (debounced). */
  onWorkspaceChanged?(params: WorkspaceChangedParams): void;
  /** MCP OAuth: open / show this authorization URL (loopback callback pending). */
  onMcpOauthRequired?(params: { name: string; url: string }): void;
}

export interface WorkspaceChangedParams {
  path: string;
  kinds: Array<"rename" | "change">;
 /** Set when the server-side watcher failed; fall back to polling. */
  error?: string;
}

export interface ConnectOptions {
 /** `ws://host:port/rpc` — the token is appended from `token`. */
  url: string;
  token?: string;
 /** Optional until the user opens a workspace folder. */
  cwd?: string;
  permissionMode?: PermissionMode;
}

export type ModelModality = "text" | "image" | "audio" | "video";

export interface ModelCapabilities {
 /** Provider-reported ceiling when `/models` returns it; otherwise omitted. */
  contextWindowMax?: number;
  contextWindow: number;
  modalities: ModelModality[];
  maxOutputTokens?: number;
}

export interface RemoteModelInfo {
  id: string;
  contextWindowMax?: number;
  modalities?: ModelModality[];
  maxOutputTokens?: number;
}

/** Writable provider preset for `config/upsertProvider`. */
export interface ConfigProviderPreset {
  provider: "anthropic" | "openai" | "copilot";
  displayName?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  smallModel?: string;
  models?: string[];
  modelCapabilities?: Record<string, ModelCapabilities>;
}

/** Redacted preset returned by `config/get` (no full apiKey). */
export interface ConfigProviderRedacted {
  provider: "anthropic" | "openai" | "copilot";
  displayName?: string;
  baseURL?: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
  model?: string;
  smallModel?: string;
  models?: string[];
  modelCapabilities?: Record<string, ModelCapabilities>;
}

export interface SelectableModelInfo {
  id: string;
  providerId: string;
  providerLabel: string;
  model: string;
  kind: "chat" | "small";
}

export interface ProviderTemplateInfo {
  id: string;
  displayName: string;
  provider: "anthropic" | "openai" | "copilot";
  baseURL?: string;
  models?: string[];
  smallModel?: string;
  description?: string;
  requiresBaseURL?: boolean;
}

export interface ConfigSnapshot {
  active: {
    provider?: string;
    model?: string;
    smallModel?: string;
    baseURL?: string;
    providerId?: string;
    hasApiKey: boolean;
    apiKeyHint?: string;
  };
  providers: Record<string, ConfigProviderRedacted>;
  selectableModels: SelectableModelInfo[];
  templates: ProviderTemplateInfo[];
  imageGen?: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean };
}

export interface SessionOptions {
  cwd?: string;
  permissionMode?: PermissionMode;
 /** Reported to the server as `clientInfo.name`. */
  clientName?: string;
}

/** A live transport plus the hooks the client needs to manage it. */
export interface OpenedTransport {
  transport: RpcTransport;
  close(): void;
  onClose(listener: () => void): void;
}

/** Opens a fresh transport; called again for every automatic reconnect. */
export type TransportOpener = () => Promise<OpenedTransport>;

/**
 * Build the WebSocket URL. The token travels as a query parameter because a
 * browser cannot set headers on a WebSocket handshake.
 */
export function buildUrl(url: string, token?: string): string {
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set("token", token);
  return u.toString();
}

/**
 * Split a pasted `codepilot serve --web` URL into its parts, so the user can
 * paste the line the CLI printed instead of filling two fields.
 */
export function parseServeUrl(input: string): { url: string; token?: string } {
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    const token = u.searchParams.get("token") ?? undefined;
    u.searchParams.delete("token");
 // `URL` keeps a trailing "?" once the only param is removed.
    return { url: u.toString().replace(/\?$/, ""), token };
  } catch {
    return { url: trimmed };
  }
}

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

  async newSession(params: {
    cwd?: string;
    model?: string;
    agentMode?: AgentMode;
    systemPromptExtra?: string;
  }): Promise<string> {
    const { sessionId } = await this.call<{ sessionId: string }>("session/new", params);
    return sessionId;
  }

  async resumeSession(sessionId: string): Promise<SessionResumeResult> {
    return this.call<SessionResumeResult>("session/resume", { sessionId });
  }

  async listWorkspace(path = ".", cwd?: string): Promise<{ path: string; entries: Array<{ name: string; path: string; kind: "file" | "directory"; size?: number }> }> {
    return this.call("workspace/list", { path, cwd });
  }

 /** Native folder dialog on the serve host (may return null if cancelled). */
  async pickFolder(): Promise<{ path: string | null; supported: boolean }> {
    return this.call("workspace/pickFolder", {});
  }

 /** Browse absolute directories on the serve host (folder picker UI). */
  async browseWorkspace(path?: string): Promise<{
    path: string;
    parent?: string;
    entries: Array<{ name: string; path: string; kind: "file" | "directory" }>;
    roots: Array<{ label: string; path: string }>;
  }> {
    return this.call("workspace/browse", { path });
  }

  async workspaceStat(path: string, cwd?: string): Promise<{ path: string; exists: boolean; size: number; hash: string; modifiedAt?: number }> {
    return this.call("workspace/stat", { path, cwd });
  }

  /** Manual compaction (`/compact`): summarise now, keep going on the task. */
  async sessionCompact(sessionId: string): Promise<{ ok: true }> {
    return this.call("session/compact", { sessionId });
  }

  /** Task boundary (`/clear`): archive context, continue with a clean slate. */
  async sessionClearContext(sessionId: string, reason?: string): Promise<{ cleared: boolean }> {
    return this.call("session/clear-context", { sessionId, reason });
  }

  /** Context-window usage report for the live session: totals + a semantic
   * breakdown (system prompt, skills, tool/MCP schemas, conversation,
   * sub-agents). Used by the context-usage panel. */
  async sessionContextReport(sessionId: string): Promise<ContextReport> {
    return this.call("session/contextReport", { sessionId });
  }

  /** List slash commands for the `/` menu (shared built-ins + md commands). */
  async commandsList(cwd?: string): Promise<{
    commands: Array<{ name: string; description: string; argumentHint?: string; source: "builtin" | "project" | "user" }>;
    warnings: string[];
  }> {
    return this.call("commands/list", { cwd });
  }

  /** `@`-mention completion candidates (file/dir/mcp/git/skill). */
  async workspaceComplete(
    query: string,
    opts: { kinds?: Array<"file" | "dir" | "mcp" | "git" | "skill">; maxResults?: number; cwd?: string } = {},
  ): Promise<{
    candidates: Array<{ kind: "file" | "dir" | "mcp" | "git" | "skill"; value: string; label: string; detail?: string }>;
  }> {
    return this.call("workspace/complete", { query, ...opts });
  }

 /** Subscribe to debounced disk-change notifications for a directory. */
  async watchWorkspace(path = ".", cwd?: string): Promise<{ watching: boolean; path: string }> {
    return this.call("workspace/watch", { path, cwd });
  }

  async gitDiff(path?: string, staged = false, cwd?: string): Promise<{ path?: string; diff: string; truncated: boolean }> {
    return this.call("workspace/git-diff", { path, staged, cwd });
  }

  async gitStatus(cwd?: string): Promise<{ branch: string; files: Array<{ path: string; index: string; worktree: string; status: string }> }> {
    return this.call("workspace/git-status", { cwd });
  }

  async gitBranches(cwd?: string): Promise<{ current: string; branches: Array<{ name: string; current: boolean; upstream?: string; ahead?: number; behind?: number }>; tags: string[]; detached: boolean }> {
    return this.call("git/branches", { cwd });
  }

  async gitInit(cwd?: string): Promise<{ ok: boolean; output: string }> {
    return this.call("git/init", { cwd });
  }

  async gitStage(paths?: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
    return this.call("git/stage", { paths, cwd });
  }

  async gitUnstage(paths?: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
    return this.call("git/unstage", { paths, cwd });
  }

  async gitCommit(message: string, all = false, cwd?: string): Promise<{ ok: boolean; output: string }> {
    return this.call("git/commit", { message, all, cwd });
  }

  async gitPush(opts: { remote?: string; branch?: string; setUpstream?: boolean; cwd?: string } = {}): Promise<{ ok: boolean; output: string }> {
    return this.call("git/push", opts);
  }

  async gitPull(opts: { remote?: string; branch?: string; cwd?: string } = {}): Promise<{ ok: boolean; output: string }> {
    return this.call("git/pull", opts);
  }

  async gitFetch(cwd?: string): Promise<{ ok: boolean; output: string }> {
    return this.call("git/fetch", { cwd });
  }

  async gitCheckout(branch: string, create = false, cwd?: string): Promise<{ ok: boolean; output: string }> {
    return this.call("git/checkout", { branch, create, cwd });
  }

  async gitCommitMessage(cwd?: string, sessionId?: string): Promise<{ message: string }> {
    return this.call("git/commit-message", { cwd, sessionId });
  }

  async writeWorkspace(path: string, content: string, expectedSize?: number, expectedHash?: string, cwd?: string): Promise<{ path: string; size: number; hash: string }> {
    return this.call("workspace/write", { path, content, expectedSize, expectedHash, cwd });
  }

  async searchWorkspace(query: string, path = ".", maxResults = 100, cwd?: string): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    return this.call("workspace/search", { query, path, maxResults, cwd });
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
    return this.call("workspace/read", { path, cwd });
  }

  /** Resolve a (bare/relative) path to an absolute one the host can open,
   * using the server's workspace basename fallback. */
  async resolveWorkspace(path: string, cwd?: string): Promise<{
    path: string;
    absolute: string;
    exists: boolean;
  }> {
    return this.call("workspace/resolve", { path, cwd });
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
    return this.call("system/update-check", {});
  }

  async applyEngineUpdate(): Promise<{
    applied: boolean;
    version: string;
    message?: string;
  }> {
    return this.call("system/update-apply", {});
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
    return this.call("remote/pair-mint", opts);
  }

  async listMcpMarkets(): Promise<{
    markets: Array<{ id: string; name: string; description: string; url: string }>;
  }> {
    return this.call("mcp/markets", {});
  }

  async installMcpJson(json: string, name?: string): Promise<{
    mcpConfigPath: string;
    names: string[];
    message: string;
  }> {
    return this.call("mcp/install-json", { json, name });
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
    return this.call("mcp/list", {});
  }

  async setMcpEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean; message: string }> {
    return this.call("mcp/set-enabled", { name, enabled });
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
    return this.call("mcp/inspect", { name });
  }

  async startMcpOauth(name: string): Promise<{
    state: "idle" | "pending" | "authorized" | "error";
    url?: string;
    error?: string;
  }> {
    return this.call("mcp/oauth-start", { name });
  }

  async mcpOauthStatus(name: string): Promise<{
    state: "idle" | "pending" | "authorized" | "error";
    url?: string;
    error?: string;
  }> {
    return this.call("mcp/oauth-status", { name });
  }

  async cancelMcpOauth(name: string): Promise<{ state: "idle" | "pending" | "authorized" | "error" }> {
    return this.call("mcp/oauth-cancel", { name });
  }

  async revokeAllRemote(): Promise<{ revoked: boolean }> {
    return this.call("remote/revoke-all", {});
  }

  async initWorkspace(opts?: {
    force?: boolean;
    filename?: "AGENTS.md" | "CODEPILOT.md";
  }): Promise<{ path: string; created: boolean; skipped: boolean }> {
    return this.call("workspace/init", opts ?? {});
  }

  async undoSession(sessionId: string): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    return this.call("session/undo", { sessionId });
  }

  async redoSession(sessionId: string): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    return this.call("session/redo", { sessionId });
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
    return this.call("connectors/list", opts ?? {});
  }

  async installConnector(
    connectorId: string,
    values: Record<string, string>,
  ): Promise<{ mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }> {
    return this.call("connectors/install", { connectorId, values });
  }

  async updateConnector(
    connectorId: string,
    values: Record<string, string>,
  ): Promise<{ mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }> {
    return this.call("connectors/update", { connectorId, values });
  }

  async setConnectorEnabled(
    connectorId: string,
    enabled: boolean,
  ): Promise<{ connectorId: string; enabled: boolean; message: string }> {
    return this.call("connectors/set-enabled", { connectorId, enabled });
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
    return this.call("skills/list", opts ?? {});
  }

  async installSkill(connectorId: string): Promise<{ skillPath: string; message: string }> {
    return this.call("skills/install", { connectorId });
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
    return this.call("skills/install-archive", { filename, dataBase64 });
  }

  async setSkillEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean; message: string }> {
    return this.call("skills/set-enabled", { name, enabled });
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
    return this.call("skills/get", { name });
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
    return this.call("skills/get-file", { name, relativePath });
  }

  async saveSkillContent(
    name: string,
    markdown: string,
  ): Promise<{ name: string; path: string; message: string }> {
    return this.call("skills/save", { name, markdown });
  }

  async saveSkillFile(
    name: string,
    relativePath: string,
    content: string,
  ): Promise<{ name: string; path: string; message: string }> {
    return this.call("skills/save-file", { name, relativePath, content });
  }

  async skillCreatorPrompt(): Promise<{ prompt: string }> {
    return this.call("skills/creator-prompt", {});
  }

  async listScheduledTasks(): Promise<{ tasks: unknown[] }> {
    return this.call("schedule/list", {});
  }

  async addScheduledTask(task: {
    title: string;
    prompt: string;
    cwd?: string;
    kind: "idle" | "once" | "daily" | "interval";
    at?: string;
    runAt?: number;
    everyMinutes?: number;
    idleAfterMs?: number;
    model?: string;
    providerId?: string;
    agentMode?: "chat" | "plan" | "agent";
  }): Promise<{ task: unknown }> {
    return this.call("schedule/add", task);
  }

  async updateScheduledTask(
    id: string,
    patch: {
      title?: string;
      prompt?: string;
      cwd?: string;
      at?: string;
      runAt?: number;
      everyMinutes?: number;
      idleAfterMs?: number;
      model?: string;
      providerId?: string;
      agentMode?: "chat" | "plan" | "agent";
      enabled?: boolean;
    },
  ): Promise<{ task: unknown }> {
    return this.call("schedule/update", { id, ...patch });
  }

  async removeScheduledTask(id: string): Promise<{ removed: boolean }> {
    return this.call("schedule/remove", { id });
  }

  async listTerminalShells(): Promise<{
    platform: "darwin" | "linux" | "win32" | "other";
    shells: Array<{ id: string; path: string; label: string }>;
  }> {
    return this.call("terminal/list-shells", {});
  }

  async openTerminal(opts: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ terminalId: string; shell: string }> {
    return this.call("terminal/open", opts);
  }

  async writeTerminal(terminalId: string, data: string): Promise<void> {
    await this.call("terminal/write", { terminalId, data });
  }

  async resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    await this.call("terminal/resize", { terminalId, cols, rows });
  }

  async closeTerminal(terminalId: string): Promise<void> {
    await this.call("terminal/close", { terminalId });
  }

 /**
 * List sessions. Pass `cwd` to filter; omit to return every session
 * (client groups them by workspace).
 */
  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const { sessions } = await this.call<{ sessions: SessionSummary[] }>(
      "session/list",
      cwd ? { cwd } : {},
    );
    return sessions;
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
    await this.call("session/pin", { sessionId, pinned });
  }

  /** Archive / unarchive a session (archived sessions are hidden by default). */
  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    await this.call("session/archive", { sessionId, archived });
  }

  async send(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    delivery?: "auto" | "queue" | "steer",
  ): Promise<{ delivery: "started" | "queued" | "steered" }> {
    const params: {
      sessionId: string;
      text: string;
      images?: ImageAttachment[];
      files?: PromptFile[];
      delivery?: "auto" | "queue" | "steer";
    } = {
      sessionId,
      text,
    };
    if (images?.length) params.images = images;
    if (files?.length) params.files = files;
    if (delivery) params.delivery = delivery;
    return this.call("prompt/send", params);
  }

  async removeFollowUp(sessionId: string, id: string): Promise<void> {
    await this.call("prompt/followup/remove", { sessionId, id });
  }

  async updateFollowUp(sessionId: string, id: string, text: string): Promise<void> {
    await this.call("prompt/followup/update", { sessionId, id, text });
  }

  async sendFollowUpNow(
    sessionId: string,
    id: string,
  ): Promise<{ delivery: "steered" | "started" | "missing" }> {
    return this.call("prompt/followup/sendNow", { sessionId, id });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call("prompt/cancel", { sessionId });
  }

  async setMode(sessionId: string, mode: AgentMode): Promise<void> {
    await this.call("session/setMode", { sessionId, mode });
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
    return this.call("session/setModel", {
      sessionId,
      model,
      providerId,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
  }

  async getEndpoint(sessionId: string): Promise<{
    model: string;
    providerId?: string;
    provider?: string;
    baseURL?: string;
    reasoningEffort?: "low" | "medium" | "high";
  }> {
    return this.call("session/getEndpoint", { sessionId });
  }

  async getConfig(cwd?: string): Promise<ConfigSnapshot> {
    return this.call("config/get", { cwd });
  }

  async setImageGen(patch: {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    enabled?: boolean;
  }): Promise<{ imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean } }> {
    return this.call("config/setImageGen", patch);
  }

  async upsertProvider(
    id: string,
    preset: ConfigProviderPreset,
    opts?: { setActive?: boolean; sessionId?: string },
  ): Promise<{ providers: Record<string, ConfigProviderRedacted> }> {
    return this.call("config/upsertProvider", {
      id,
      preset,
      setActive: opts?.setActive,
      sessionId: opts?.sessionId,
    });
  }

  async deleteProvider(id: string): Promise<{ providers: Record<string, ConfigProviderRedacted> }> {
    return this.call("config/deleteProvider", { id });
  }

  async setActiveProvider(
    providerId: string,
    opts?: { model?: string; sessionId?: string; persist?: boolean },
  ): Promise<{ model: string; providerId: string }> {
    return this.call("config/setActive", {
      providerId,
      model: opts?.model,
      sessionId: opts?.sessionId,
      persist: opts?.persist,
    });
  }

  async listRemoteModels(opts: {
    providerId?: string;
    provider?: "anthropic" | "openai" | "copilot";
    baseURL?: string;
    apiKey?: string;
  }): Promise<RemoteModelInfo[]> {
    const { models } = await this.call<{ models: RemoteModelInfo[] }>(
      "config/listRemoteModels",
      opts,
    );
    return models;
  }

  async fork(sessionId: string, atEventIndex?: number): Promise<string> {
    const { sessionId: forked } = await this.call<{ sessionId: string }>(
      "session/fork",
      { sessionId, atEventIndex },
    );
    return forked;
  }

  async respondPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    await this.call("permission/respond", { requestId, decision });
  }

  async respondQuestion(
    requestId: string,
    answers: QuestionAnswers,
  ): Promise<void> {
    await this.call("question/respond", { requestId, answers });
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

/** Human-readable message for an RPC failure. */
export function describeError(err: unknown): string {
  if (err instanceof RpcError) {
 // -32000 is SessionNotFound: the common case after a server restart, and
 // "session not found" alone does not tell the user what to do about it.
    if (err.code === -32000) {
      return `${err.message} — the server may have restarted; pick or start another session`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
