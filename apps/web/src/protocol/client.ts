// Browser-side protocol client (docs/PROTOCOL.md, ROADMAP-NEXT §4.3 Phase 2).
//
// Wraps `Peer` with the CodePilot method surface and turns the two
// server-initiated requests (`permission/request`, `question/request`) into
// callbacks the UI can render as dialogs.
//
// Everything imported from `@codepilot/core` here is `import type` on
// purpose: those types are erased at build time, so no Node-only code reaches
// the bundle. The runtime import is `@codepilot/protocol/rpc`, which has no
// dependencies at all.

import { Peer, RpcError } from "@codepilot/protocol/rpc";
import type {
  AgentMode,
  Event,
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

export const PROTOCOL_VERSION = 1;

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  reason: string;
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
  /** Transport went away — the UI should offer to reconnect. */
  onClose(reason?: string): void;
  /** Automatic reconnect succeeded after a transport drop. */
  onReconnected?(init: InitializeResult): void;
  /** Automatic reconnect is being attempted. */
  onReconnecting?(attempt: number, delayMs: number): void;
  /** A watched workspace directory changed on disk (debounced). */
  onWorkspaceChanged?(params: WorkspaceChangedParams): void;
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
  cwd: string;
  permissionMode?: PermissionMode;
}

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
  private transport: BrowserWebSocketTransport | null = null;
  private capabilities: InitializeResult["capabilities"] | null = null;
  private lastConnect: ConnectOptions | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  /** UI-level workspace-change sink (the panel swaps this per render). */
  private workspaceChangedHandler: ((p: WorkspaceChangedParams) => void) | null = null;

  setWorkspaceChangedHandler(handler: ((p: WorkspaceChangedParams) => void) | null): void {
    this.workspaceChangedHandler = handler;
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

  async connect(opts: ConnectOptions): Promise<InitializeResult> {
    this.manualDisconnect = false;
    this.lastConnect = { ...opts };
    this.clearReconnectTimer();
    await this.disconnect({ markManual: false });
    const socket = new WebSocket(buildUrl(opts.url, opts.token));
    await waitForOpen(socket);
    const transport = new BrowserWebSocketTransport(socket);
    const peer = new Peer({ transport, debug: false });
    this.transport = transport;
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
    peer.onRequest<PermissionRequestParams, Record<string, never>>(
      "permission/request",
      (p) => {
        this.callbacks.onPermission({
          requestId: p.requestId,
          sessionId: p.sessionId,
          toolName: p.toolName,
          input: p.input,
          reason: p.reason,
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
    socket.addEventListener("close", () => {
      if (this.peer === peer) this.handleClosed("socket closed");
    });

    const init = await peer.request<unknown, InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? "ask",
      clientInfo: { name: "codepilot-web", version: "2.0.0" },
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
    const opts = this.lastConnect;
    if (!opts || this.manualDisconnect) return;
    // `connect()` remembers these options again and clears stale state; if it
    // throws, the failure callbacks below keep the retry loop alive.
    try {
      const init = await this.connect(opts);
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

  async listWorkspace(path = "."): Promise<{ path: string; entries: Array<{ name: string; path: string; kind: "file" | "directory"; size?: number }> }> {
    return this.call("workspace/list", { path });
  }

  async workspaceStat(path: string): Promise<{ path: string; exists: boolean; size: number; hash: string; modifiedAt?: number }> {
    return this.call("workspace/stat", { path });
  }

  /** Subscribe to debounced disk-change notifications for a directory. */
  async watchWorkspace(path = "."): Promise<{ watching: boolean; path: string }> {
    return this.call("workspace/watch", { path });
  }

  async gitDiff(path?: string, staged = false): Promise<{ path?: string; diff: string; truncated: boolean }> {
    return this.call("workspace/git-diff", { path, staged });
  }

  async gitStatus(): Promise<{ branch: string; files: Array<{ path: string; index: string; worktree: string; status: string }> }> {
    return this.call("workspace/git-status", {});
  }

  async writeWorkspace(path: string, content: string, expectedSize?: number, expectedHash?: string): Promise<{ path: string; size: number; hash: string }> {
    return this.call("workspace/write", { path, content, expectedSize, expectedHash });
  }

  async searchWorkspace(query: string, path = ".", maxResults = 100): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    return this.call("workspace/search", { query, path, maxResults });
  }

  async readWorkspace(path: string): Promise<{ path: string; content: string; size: number; hash: string; truncated: boolean }> {
    return this.call("workspace/read", { path });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const { sessions } = await this.call<{ sessions: SessionSummary[] }>(
      "session/list",
      {},
    );
    return sessions;
  }

  async send(sessionId: string, text: string): Promise<void> {
    await this.call("prompt/send", { sessionId, text });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call("prompt/cancel", { sessionId });
  }

  async setMode(sessionId: string, mode: AgentMode): Promise<void> {
    await this.call("session/setMode", { sessionId, mode });
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
