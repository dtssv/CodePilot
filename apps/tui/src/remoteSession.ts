// RemoteSession: a drop-in stand-in for a core `Session` that talks to a
// running `codepilot serve` over WebSocket instead of running the agent loop
// in-process. This is what lets `codepilot-tui` FOLLOW a session that the web
// (or another client) is driving — events stream in live, and prompts/cancels
// from the terminal drive the same shared session on the server.
//
// It implements only the surface the TUI actually uses (subscribe, getEvents,
// prompt, cancel, setModel, setAgentMode, getAgentMode, getModel, getUsage,
// dispose, id). Permission/question reverse-requests from the server are
// routed into the same bridges the in-process session would use, so the UI is
// identical whether local or remote.

import type { AgentMode, Event, PermissionResolution, QuestionAnswers } from "@codepilot/core";
import { Peer } from "@codepilot/protocol/rpc";
import { WebSocketTransport } from "@codepilot/protocol/ws";

export interface RemoteSessionOptions {
  url: string;
  token?: string;
  cwd: string;
 /** Resume this session id; omit to start a fresh one (default). */
  sessionId?: string;
 /** When true (and no sessionId), attach to the server's NEWEST session
 * instead of creating a fresh one. Opt-in — the default is a new session
 * so a terminal never silently hijacks whatever the web is showing. */
  attachNewest?: boolean;
  agentMode?: AgentMode;
  onPermissionRequest: (req: {
    requestId: string;
    toolName: string;
    input: unknown;
    reason: string;
  }) => Promise<PermissionResolution>;
  onAskUser: (req: {
    requestId: string;
    questions: { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
  }) => Promise<QuestionAnswers>;
 /** Another client following the session answered a pending request. */
  onPromptResolved?: (kind: "permission" | "question", requestId: string) => void;
 /** Connection state changes (for a status line while auto-reconnecting). */
  onConnectionChange?: (state: "connected" | "reconnecting" | "lost") => void;
}

type Listener = (e: Event) => void;

const PROTOCOL_VERSION = 1;

function wsUrl(url: string, token?: string): string {
  let u = url.trim();
  if (!/^wss?:\/\//.test(u)) u = `ws://${u}`;
  if (token && !/[?&]token=/.test(u)) u += (u.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}`;
  return u;
}

/**
 * True for the family of errors a dropped socket produces: a write after the
 * transport closed, or an in-flight request rejected when the peer loop ended
 * ("peer disconnected" / "peer closed" / "transport read failed").
 */
function isDisconnectError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /transport closed|peer disconnected|peer closed|transport read failed/i.test(err.message)
  );
}

export class RemoteSession {
  id: string;
  private peer: Peer;
  private socket: { close(): void };
  private readonly listeners = new Set<Listener>();
  private events: Event[] = [];
  private mode: AgentMode;
  private model = "";
  private providerId: string | undefined;
  private usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
  private disposed = false;
  private cwd = "";
  private _busy = false;
 /** Config snapshot fetched from the server (providers / statusLine), used
 * by read-only UI like the model picker and status bar. */
  private configSnapshot: Record<string, unknown> = {};
  private opts!: RemoteSessionOptions;
 /** In-flight reconnect, so overlapping failures await one attempt. */
  private reconnecting: Promise<void> | null = null;

 /** Emit a connection-state change to both the optional hook and the UI
  * stream (as a transient recoverable banner the transcript already renders). */
  private emitConnection(state: "connected" | "reconnecting" | "lost"): void {
    this.opts.onConnectionChange?.(state);
    const text =
      state === "reconnecting"
        ? "Connection to the shared server dropped — reconnecting…"
        : state === "lost"
          ? "Still trying to reach the shared server…"
          : "Reconnected to the shared server.";
    // `recoverable: true` renders as a transient banner, cleared on the next turn.
    for (const l of this.listeners) {
      try {
        l({ type: "error", message: text, recoverable: true } as unknown as Event);
      } catch {
        /* listener errors are not fatal */
      }
    }
  }

  private constructor(id: string, peer: Peer, socket: { close(): void }, mode: AgentMode) {
    this.id = id;
    this.peer = peer;
    this.socket = socket;
    this.mode = mode;
  }

 /** Connect to a serve, attach to a session, and return a ready RemoteSession. */
  static async connect(opts: RemoteSessionOptions): Promise<RemoteSession> {
    const self = new RemoteSession("", null as unknown as Peer, { close() {} }, opts.agentMode ?? "agent");
    self.cwd = opts.cwd;
    self.opts = opts;
    const peer = await self.openPeer();

 // Resolve the target session. Priority:
 // 1. explicit sessionId → resume & FOLLOW it (true two-end sync).
 // 2. --attach (attachNewest) → follow the server's newest session.
 // 3. default → start a FRESH session, so the terminal runs independently
 // and never hijacks whatever another client is already viewing.
    let sessionId = opts.sessionId;
    if (!sessionId && opts.attachNewest) {
      const { sessions } = await peer.request<unknown, { sessions: { id: string; updatedAt?: number }[] }>(
        "session/list",
        {},
      );
      sessionId = [...(sessions ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.id;
    }
    self.id = sessionId ?? "";

 // Fetch a config snapshot (providers / model / statusLine) for read-only UI.
    await self.fetchConfigSnapshot();

    if (sessionId) {
      const res = await peer.request<unknown, { sessionId: string; events: Event[] }>("session/resume", { sessionId });
      self.events = res.events ?? [];
 // Seed derived state from history.
      for (const e of self.events) self.deriveState(e);
    } else {
      const res = await peer.request<unknown, { sessionId: string }>("session/new", { cwd: opts.cwd });
      self.id = res.sessionId;
    }
    self.opts.onConnectionChange?.("connected");
    return self;
  }

 /**
  * Open a fresh WebSocket + Peer, wire the reverse-request and notification
  * handlers, and run `initialize`. Used by both the first connect and every
  * auto-reconnect. Installs a close handler that triggers reconnection unless
  * the session has been disposed.
  */
  private async openPeer(): Promise<Peer> {
    const opts = this.opts;
    const { WebSocket } = await import("ws");
    const socket = new WebSocket(wsUrl(opts.url, opts.token));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (e: Error) => reject(e));
    });
    const transport = new WebSocketTransport(socket);
    const peer = new Peer({ transport });

 // Reverse requests from the server → the TUI's bridges.
    peer.onRequest("permission/request", async (p: unknown) => {
      const req = p as { requestId: string; toolName: string; input: unknown; reason: string };
      const resolution = await opts.onPermissionRequest(req);
      // Flatten a decline-with-feedback object onto the wire shape the server's
      // `permission/respond` understands ({ decision, feedback }).
      if (typeof resolution === "string") return { decision: resolution };
      return { decision: resolution.decision, feedback: resolution.feedback };
    });
    peer.onRequest("question/request", async (p: unknown) => {
      const req = p as RemoteSessionOptions["onAskUser"] extends (r: infer R) => unknown ? R : never;
      const answers = await opts.onAskUser(req as never);
      return { answers };
    });
    for (const kind of ["permission", "question"] as const) {
      peer.onNotification(`${kind}/resolved`, (p: unknown) => {
        const { sessionId: sid, requestId } = p as { sessionId: string; requestId: string };
        if (sid === this.id) opts.onPromptResolved?.(kind, requestId);
      });
    }
 // Stream events into the local mirror + listeners.
    peer.onNotification("event", (p: unknown) => {
      const { sessionId: sid, event } = p as { sessionId: string; event: Event };
      if (sid !== this.id) return;
      this.ingest(event);
    });

    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: opts.cwd,
      permissionMode: "ask",
      clientInfo: { name: "codepilot-tui", version: "0" },
    });

 // A close on a live session (server reaped an idle socket, restart, blip)
 // kicks off auto-reconnect. An intentional dispose skips this.
    socket.on("close", () => {
      if (this.disposed) return;
      void this.reconnect();
    });

    this.peer = peer;
    this.socket = socket as unknown as { close(): void };
    return peer;
  }

 /** Best-effort config snapshot for read-only UI (model / providers). */
  private async fetchConfigSnapshot(): Promise<void> {
    try {
      const cfg = await this.peer.request<unknown, {
        active: { provider?: string; model?: string; providerId?: string; onboardedAt?: string };
        providers: Record<string, unknown>;
        selectableModels: unknown;
      }>("config/get", { cwd: this.opts.cwd });
      this.configSnapshot = {
        provider: cfg.active?.provider,
        model: cfg.active?.model,
        providers: cfg.providers ?? {},
        // Carry the first-run marker so the TUI's setup guide doesn't re-open
        // every launch when following a shared server.
        onboardedAt: cfg.active?.onboardedAt,
      };
      if (cfg.active?.model) this.model = cfg.active.model;
      if (cfg.active?.providerId) this.providerId = cfg.active.providerId;
    } catch {
 /* best-effort; UI degrades gracefully */
    }
  }

 /**
  * Re-establish the socket to the same daemon and re-attach to the same
  * session, with capped exponential backoff. Concurrent callers share one
  * attempt. Resolves once reconnected; stays trying until disposed.
  */
  private reconnect(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.reconnecting) return this.reconnecting;
    this.emitConnection("reconnecting");
    this.reconnecting = (async () => {
      let delay = 300;
      for (let attempt = 0; !this.disposed; attempt++) {
        try {
          await this.openPeer();
          if (this.id) {
            const res = await this.peer.request<unknown, { sessionId: string; events: Event[] }>(
              "session/resume",
              { sessionId: this.id },
            );
            // Replay any events the UI missed while the socket was down.
            const known = this.events.length;
            const fresh = res.events ?? [];
            for (let i = known; i < fresh.length; i++) this.ingest(fresh[i]!);
          }
          await this.fetchConfigSnapshot();
          this.emitConnection("connected");
          return;
        } catch {
          this.emitConnection("lost");
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 5_000);
        }
      }
    })();
    const attempt = this.reconnecting;
    void attempt.finally(() => {
      if (this.reconnecting === attempt) this.reconnecting = null;
    });
    return attempt;
  }

 /**
  * Run an RPC, transparently waiting for an in-flight reconnect and retrying
  * once if the socket dropped — so read-only calls like the /resume picker
  * self-heal instead of surfacing "websocket transport closed".
  */
  private async rpc<R>(method: string, params: unknown): Promise<R> {
    try {
      return await this.peer.request<unknown, R>(method, params);
    } catch (err) {
      if (this.disposed || !isDisconnectError(err)) throw err;
      await this.reconnect();
      return await this.peer.request<unknown, R>(method, params);
    }
  }

  private deriveState(e: Event): void {
    if (e.type === "mode") this.mode = e.mode;
    else if (e.type === "model") { this.model = e.model; this.providerId = e.providerId; }
    else if (e.type === "status") {
      this._busy = e.status === "running" || e.status === "waiting_permission" || e.status === "compacting";
    }
    else if (e.type === "usage") {
      this.usage.input += e.usage.input ?? 0;
      this.usage.output += e.usage.output ?? 0;
      this.usage.cacheRead += e.usage.cacheRead ?? 0;
      this.usage.cacheWrite += e.usage.cacheWrite ?? 0;
      this.usage.costUSD += e.usage.costUSD ?? 0;
    }
  }

  private ingest(e: Event): void {
    this.events.push(e);
    this.deriveState(e);
    for (const l of this.listeners) {
      try { l(e); } catch { /* listener errors are not fatal */ }
    }
  }

 // ---- Session-compatible surface the TUI uses --------------------------

  subscribe(listener: Listener): () => void {
    for (const e of this.events) {
      try { listener(e); } catch { /* ignore */ }
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getEvents(): Event[] {
    return this.events.slice();
  }

 /** Every session the server knows, for the /resume picker. */
  async listSessions(): Promise<{ id: string; title: string; updatedAt: number; cwd: string; messageCount: number }[]> {
    const res = await this.rpc<{ sessions: { id: string; title: string; updatedAt: number; cwd: string; messageCount?: number }[] }>(
      "session/list",
      {},
    );
    return (res.sessions ?? []).map((s) => ({ ...s, messageCount: s.messageCount ?? 0 }));
  }

 /** Follow another server session over a fresh connection (the caller
 * disposes this one). */
  reopen(sessionId: string): Promise<RemoteSession> {
    return RemoteSession.connect({ ...this.opts, sessionId, attachNewest: false, agentMode: this.mode });
  }

  async prompt(
    text: string,
    images?: unknown,
    delivery?: "auto" | "queue" | "steer",
  ): Promise<"started" | "queued" | "steered"> {
    const res = await this.rpc<{ delivery?: "started" | "queued" | "steered" }>(
      "prompt/send",
      { sessionId: this.id, text, images, delivery: delivery ?? "auto" },
    );
    return res?.delivery ?? "started";
  }

  steer(text: string): void {
    void this.peer
      .request("prompt/send", { sessionId: this.id, text, delivery: "steer" })
      .catch(() => {});
  }

  /**
   * Resume the last turn from the breakpoint (no new user message). The server
   * decides whether there is anything to resume and returns `noop` if not, so
   * the TUI can fall back to re-sending the last prompt.
   */
  async resumeLastTurn(): Promise<"started" | "queued" | "noop"> {
    const res = await this.rpc<{ delivery?: "started" | "queued" | "noop" }>(
      "prompt/resume",
      { sessionId: this.id },
    );
    return res?.delivery ?? "noop";
  }

  isBusy(): boolean {
    return this._busy;
  }

  cancel(): void {
    void this.peer.request("prompt/cancel", { sessionId: this.id }).catch(() => {});
  }

  async setModel(model: string, providerId?: string): Promise<void> {
    const res = await this.peer.request<unknown, { model: string; providerId?: string }>(
      "session/setModel",
      { sessionId: this.id, model, providerId },
    );
    this.model = res.model ?? model;
    this.providerId = res.providerId ?? providerId;
  }

  async setAgentMode(mode: AgentMode): Promise<void> {
    await this.peer.request("session/setMode", { sessionId: this.id, mode }).catch(() => {});
    this.mode = mode;
  }

  getAgentMode(): AgentMode {
    return this.mode;
  }

  getModel(): string {
    return this.model;
  }

  getProviderId(): string | undefined {
    return this.providerId;
  }

  getUsage(): { input: number; output: number; cacheRead: number; cacheWrite: number; costUSD: number } {
    return { ...this.usage };
  }

 // ---- Read-only / local-concept methods used by the TUI chrome ----------
 // On a remote session these are either served from the config snapshot or
 // are local-only concepts that don't apply — we return safe values so the
 // UI renders and degrades gracefully rather than crashing.

  getStatusLineConfig(): unknown {
    return (this.configSnapshot as { statusLine?: unknown }).statusLine;
  }

  getConfig(): Record<string, unknown> {
    return { ...this.configSnapshot, model: this.model };
  }

  getCwd(): string {
    return this.cwd;
  }

  async setProvider(providerId: string, model?: string): Promise<void> {
    const res = await this.peer
      .request<unknown, { model: string; providerId?: string }>("session/setModel", {
        sessionId: this.id,
        provider: providerId,
        model,
      })
      .catch(() => ({ model: model ?? this.model, providerId }));
    this.model = res.model ?? model ?? this.model;
    this.providerId = res.providerId ?? providerId;
  }

  mergeProviders(_providers: Record<string, unknown>): void {
 // Provider presets live in the server's config; a remote client can't
 // mutate them here. No-op — the model/provider picker still works via
 // setModel/setProvider over RPC.
    void _providers;
  }

  setTurnOverrides(_opts: { model?: string; allowedTools?: string[] } = {}): void {
 // Turn-scoped overrides are a server-side concept; not supported from a
 // remote client. No-op (the prompt still runs on the server as-is).
    void _opts;
  }

  filterToolRegistry(_allowedTools: string[]): void {
    void _allowedTools; // server owns the tool registry
  }

  getMcpManager(): null {
    return null; // MCP runs on the server; not introspectable from here
  }

  getHookEngine(): null {
    return null; // hooks run on the server
  }

  contextReport(): {
    totalTokens: number;
    window: number;
    triggerThreshold: number;
    triggerFraction: number;
    usagePercent: number;
    autoCompactEnabled: boolean;
    byEventType: { type: string; tokens: number; count: number }[];
    topFileReads: { path: string; reads: number; tokens: number }[];
    duplicateReads: { path: string; reads: number }[];
  } {
 // Minimal report from what we can see client-side (usage totals). Detailed
 // per-event breakdown lives on the server; we keep the shape so the
 // /context command renders without a special case.
    const total = this.usage.input + this.usage.output;
    return {
      totalTokens: total,
      window: 0,
      triggerThreshold: 0,
      triggerFraction: 0.92,
      usagePercent: 0,
      autoCompactEnabled: true,
      byEventType: [],
      topFileReads: [],
      duplicateReads: [],
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    try { await this.peer.close(); } catch { /* ignore */ }
    try { this.socket.close(); } catch { /* ignore */ }
  }

 /** Test seam: force the current socket closed to exercise auto-reconnect. */
  __dropSocketForTest(): void {
    const s = this.socket as unknown as { terminate?: () => void; close(): void };
    if (typeof s.terminate === "function") s.terminate();
    else s.close();
  }
}
