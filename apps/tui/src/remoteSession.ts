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

import type { AgentMode, Event, PermissionDecision, QuestionAnswers } from "@codepilot/core";
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
  }) => Promise<PermissionDecision>;
  onAskUser: (req: {
    requestId: string;
    questions: { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
  }) => Promise<QuestionAnswers>;
 /** Another client following the session answered a pending request. */
  onPromptResolved?: (kind: "permission" | "question", requestId: string) => void;
}

type Listener = (e: Event) => void;

const PROTOCOL_VERSION = 1;

function wsUrl(url: string, token?: string): string {
  let u = url.trim();
  if (!/^wss?:\/\//.test(u)) u = `ws://${u}`;
  if (token && !/[?&]token=/.test(u)) u += (u.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}`;
  return u;
}

export class RemoteSession {
  readonly id: string;
  private readonly peer: Peer;
  private readonly socket: { close(): void };
  private readonly listeners = new Set<Listener>();
  private events: Event[] = [];
  private mode: AgentMode;
  private model = "";
  private providerId: string | undefined;
  private usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
  private disposed = false;
  private cwd = "";
 /** Config snapshot fetched from the server (providers / statusLine), used
 * by read-only UI like the model picker and status bar. */
  private configSnapshot: Record<string, unknown> = {};
  private opts!: RemoteSessionOptions;

  private constructor(id: string, peer: Peer, socket: { close(): void }, mode: AgentMode) {
    this.id = id;
    this.peer = peer;
    this.socket = socket;
    this.mode = mode;
  }

 /** Connect to a serve, attach to a session, and return a ready RemoteSession. */
  static async connect(opts: RemoteSessionOptions): Promise<RemoteSession> {
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
      const decision = await opts.onPermissionRequest(req);
      return { decision };
    });
    peer.onRequest("question/request", async (p: unknown) => {
      const req = p as RemoteSessionOptions["onAskUser"] extends (r: infer R) => unknown ? R : never;
      const answers = await opts.onAskUser(req as never);
      return { answers };
    });

    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: opts.cwd,
      permissionMode: "ask",
      clientInfo: { name: "codepilot-tui", version: "0" },
    });

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

    const self = new RemoteSession(sessionId ?? "", peer, socket as unknown as { close(): void }, opts.agentMode ?? "agent");
    self.cwd = opts.cwd;
    self.opts = opts;
    for (const kind of ["permission", "question"] as const) {
      peer.onNotification(`${kind}/resolved`, (p: unknown) => {
        const { sessionId: sid, requestId } = p as { sessionId: string; requestId: string };
        if (sid === self.id) opts.onPromptResolved?.(kind, requestId);
      });
    }
 // Fetch a config snapshot (providers / model / statusLine) for read-only UI.
    try {
      const cfg = await peer.request<unknown, {
        active: { provider?: string; model?: string; providerId?: string };
        providers: Record<string, unknown>;
        selectableModels: unknown;
      }>("config/get", { cwd: opts.cwd });
      self.configSnapshot = {
        provider: cfg.active?.provider,
        model: cfg.active?.model,
        providers: cfg.providers ?? {},
      };
      if (cfg.active?.model) self.model = cfg.active.model;
      if (cfg.active?.providerId) self.providerId = cfg.active.providerId;
    } catch {
 /* best-effort; UI degrades gracefully */
    }

 // Stream events into the local mirror + listeners.
    peer.onNotification("event", (p: unknown) => {
      const { sessionId: sid, event } = p as { sessionId: string; event: Event };
      if (sid !== self.id) return;
      self.ingest(event);
    });

    if (sessionId) {
      const res = await peer.request<unknown, { sessionId: string; events: Event[] }>("session/resume", { sessionId });
      self.events = res.events ?? [];
 // Seed derived state from history.
      for (const e of self.events) self.deriveState(e);
    } else {
      const res = await peer.request<unknown, { sessionId: string }>("session/new", { cwd: opts.cwd });
      (self as { id: string }).id = res.sessionId;
    }
    return self;
  }

  private deriveState(e: Event): void {
    if (e.type === "mode") this.mode = e.mode;
    else if (e.type === "model") { this.model = e.model; this.providerId = e.providerId; }
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
    const res = await this.peer.request<unknown, { sessions: { id: string; title: string; updatedAt: number; cwd: string; messageCount?: number }[] }>(
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

  async prompt(text: string, images?: unknown): Promise<void> {
    await this.peer.request("prompt/send", { sessionId: this.id, text, images });
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
}
