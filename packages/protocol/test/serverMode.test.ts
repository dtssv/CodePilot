/**
 * Server tests for collaboration-mode (AgentMode) support.
 *
 * Mocks @codepilot/core and exercises session/setMode, capabilities.modes, and
 * session/new (with agentMode).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: unknown) => void;

class FakeSession {
  id: string;
  cwd: string;
  events: unknown[] = [];
  listeners = new Set<Listener>();
  cancelled = false;
  setModeCalls: string[] = [];
  currentMode: string = "agent";

  static counter = 0;

  constructor(opts: { cwd: string; id?: string; history?: unknown[]; agentMode?: string }) {
    this.id = opts.id ?? `s${++FakeSession.counter}`;
    this.cwd = opts.cwd;
    this.events = opts.history ? [...opts.history] : [];
    this.currentMode = opts.agentMode ?? "agent";
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    for (const e of this.events) listener(e);
    return () => this.listeners.delete(listener);
  }
  getEvents() {
    return [...this.events];
  }
  emit(e: unknown) {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
  async prompt(): Promise<void> {
    /* no-op */
  }
  cancel() {
    this.cancelled = true;
  }
  async fork(): Promise<FakeSession> {
    return new FakeSession({ cwd: this.cwd });
  }
  async setAgentMode(mode: string): Promise<void> {
    this.setModeCalls.push(mode);
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    const ev = { type: "mode", mode };
    this.events.push(ev);
    for (const l of this.listeners) l(ev);
  }
  getAgentMode(): string {
    return this.currentMode;
  }
  async dispose(): Promise<void> {
    this.listeners.clear();
  }
}

const sessionsById = new Map<string, FakeSession>();

vi.mock("@codepilot/core", () => ({
  createSession: vi.fn(async (opts: any) => {
    const id = opts.sessionId;
    let s = id ? sessionsById.get(id) : undefined;
    if (!s) {
      s = new FakeSession({ cwd: opts.cwd, agentMode: opts.agentMode });
      sessionsById.set(s.id, s);
    }
    return s;
  }),
  listSessions: vi.fn(async () => []),
  loadConfig: vi.fn(async () => undefined),
}));

import {
  PROTOCOL_VERSION,
  registerServer,
  type InitializeParams,
  type SessionNewParams,
  type SessionSetModeParams,
} from "../src/server.js";
import { Peer, RpcError, type RpcTransport } from "../src/rpc.js";

function transportPair() {
  let open = true;
  const aBuf: string[] = [];
  const bBuf: string[] = [];
  let aWaiter: ((line: string | null) => void) | null = null;
  let bWaiter: ((line: string | null) => void) | null = null;

  const wakeA = (line: string | null) => {
    if (aWaiter) {
      const w = aWaiter;
      aWaiter = null;
      w(line);
    } else if (line !== null) {
      aBuf.push(line);
    }
  };
  const wakeB = (line: string | null) => {
    if (bWaiter) {
      const w = bWaiter;
      bWaiter = null;
      w(line);
    } else if (line !== null) {
      bBuf.push(line);
    }
  };

  const aTransport: RpcTransport = {
    write: (line) => {
      if (!open) throw new Error("a closed");
      wakeB(line.replace(/\n$/, ""));
    },
    readLine: () => {
      if (aBuf.length > 0) return Promise.resolve(aBuf.shift()!);
      if (!open) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => (aWaiter = resolve));
    },
    close: () => wakeA(null),
  };
  const bTransport: RpcTransport = {
    write: (line) => {
      if (!open) throw new Error("b closed");
      wakeA(line.replace(/\n$/, ""));
    },
    readLine: () => {
      if (bBuf.length > 0) return Promise.resolve(bBuf.shift()!);
      if (!open) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => (bWaiter = resolve));
    },
    close: () => wakeB(null),
  };

  return {
    aTransport,
    bTransport,
    closeAll: () => {
      open = false;
      wakeA(null);
      wakeB(null);
    },
  };
}

async function settled() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("server — collaboration modes (AgentMode)", () => {
  let tp: ReturnType<typeof transportPair>;
  let server: Peer;
  let client: Peer;

  beforeEach(() => {
    sessionsById.clear();
    vi.clearAllMocks();
    tp = transportPair();
    server = new Peer({ transport: tp.aTransport, debug: false });
    client = new Peer({ transport: tp.bTransport, debug: false });
  });
  afterEach(async () => {
    tp.closeAll();
    await Promise.allSettled([server.close(), client.close()]);
  });

  it("initialize returns capabilities.modes = ['chat','plan','agent']", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    const res = await client.request<
      InitializeParams,
      { protocolVersion: number; capabilities: { tools: string[]; providers: string[]; modes: string[] } }
    >("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    expect(res.capabilities.modes).toEqual(["chat", "plan", "agent"]);
  });

  it("session/new forwards agentMode to createSession", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<SessionNewParams, { sessionId: string }>(
      "session/new",
      { agentMode: "plan" },
    );
    const s = sessionsById.get(sessionId)!;
    expect(s.getAgentMode()).toBe("plan");
  });

  it("session/new defaults to agent mode when no agentMode given", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<SessionNewParams, { sessionId: string }>(
      "session/new",
      {},
    );
    const s = sessionsById.get(sessionId)!;
    expect(s.getAgentMode()).toBe("agent");
  });

  it("session/setMode calls setAgentMode and emits a mode event", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<SessionNewParams, { sessionId: string }>(
      "session/new",
      {},
    );

    // Subscribe to the event stream so we can observe the mode event.
    const modeEvents: unknown[] = [];
    client.onNotification("event", (params: any) => {
      if (params?.event?.type === "mode") modeEvents.push(params.event);
    });

    await client.request<SessionSetModeParams, Record<string, never>>(
      "session/setMode",
      { sessionId, mode: "chat" },
    );
    await settled();

    const s = sessionsById.get(sessionId)!;
    expect(s.setModeCalls).toEqual(["chat"]);
    expect(s.getAgentMode()).toBe("chat");
    expect(modeEvents.length).toBeGreaterThanOrEqual(1);
    expect((modeEvents[0] as { mode: string }).mode).toBe("chat");
  });

  it("session/setMode rejects unknown sessions with SessionNotFound", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    try {
      await client.request<SessionSetModeParams, Record<string, never>>(
        "session/setMode",
        { sessionId: "missing", mode: "plan" },
      );
      throw new Error("should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32000); // SessionNotFound
    }
  });

  it("session/setMode rejects unknown modes with InvalidParams", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<SessionNewParams, { sessionId: string }>(
      "session/new",
      {},
    );
    try {
      await client.request<SessionSetModeParams, Record<string, never>>(
        "session/setMode",
        { sessionId, mode: "totale" as unknown as "agent" },
      );
      throw new Error("should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32602); // InvalidParams
    }
  });
});