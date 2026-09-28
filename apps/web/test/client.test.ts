// Browser protocol client, driven against a fake WebSocket that plays the
// server side. Exercises the real `Peer` from @codepilot/protocol/rpc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "@codepilot/core";
import {
  buildUrl,
  CodepilotClient,
  describeError,
  parseServeUrl,
  type PendingPermission,
  type PendingQuestion,
} from "../src/protocol/client.js";
import { BrowserWebSocketTransport } from "../src/protocol/transport.js";
import { RpcError } from "@codepilot/protocol/rpc";

// --- Fake WebSocket -------------------------------------------------------

type Handler = (ev: unknown) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  /** Set to make the next socket fail its handshake. */
  static failNext = false;

  readyState = 0;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly willFail: boolean;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    this.willFail = FakeWebSocket.failNext;
    FakeWebSocket.failNext = false;
    if (!this.willFail) {
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.fire("open", {});
      }, 0);
    }
  }

  /** Drive a socket created with `failNext` through its failed handshake. */
  failHandshake(): void {
    this.fire("error", {});
    this.fire("close", {});
  }

  addEventListener(type: string, handler: Handler): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
  }
  removeEventListener(type: string, handler: Handler): void {
    this.handlers.get(type)?.delete(handler);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.fire("close", {});
  }

  /** Server → client. */
  deliver(msg: unknown): void {
    this.fire("message", { data: JSON.stringify(msg) });
  }
  /** A frame that is not text — the protocol never uses these. */
  deliverBinary(): void {
    this.fire("message", { data: new Uint8Array([1, 2, 3]) });
  }
  /** The requests the client has sent, parsed. */
  requests(): Array<{ id?: number; method?: string; params?: any; result?: any }> {
    return this.sent.map((s) => JSON.parse(s));
  }
  lastRequest(method: string): { id?: number; params?: any } | undefined {
    return [...this.requests()].reverse().find((m) => m.method === method);
  }
  /** Reply to the client's request for `method` with `result`. */
  reply(method: string, result: unknown): void {
    const req = this.lastRequest(method);
    if (!req) throw new Error(`client never called ${method}`);
    this.deliver({ jsonrpc: "2.0", id: req.id, result });
  }
  replyError(method: string, code: number, message: string): void {
    const req = this.lastRequest(method);
    if (!req) throw new Error(`client never called ${method}`);
    this.deliver({ jsonrpc: "2.0", id: req.id, error: { code, message } });
  }

  private fire(type: string, ev: unknown): void {
    for (const h of this.handlers.get(type) ?? []) h(ev);
  }
}

const CAPABILITIES = {
  tools: ["bash", "read_file"],
  providers: ["anthropic"],
  modes: ["chat", "plan", "agent"],
};

function callbacks() {
  const events: Array<{ sessionId: string; event: Event }> = [];
  const permissions: PendingPermission[] = [];
  const questions: PendingQuestion[] = [];
  let closed = 0;
  return {
    events,
    permissions,
    questions,
    closedCount: () => closed,
    cb: {
      onEvent: (sessionId: string, event: Event) => void events.push({ sessionId, event }),
      onPermission: (req: PendingPermission) => void permissions.push(req),
      onQuestion: (req: PendingQuestion) => void questions.push(req),
      onClose: () => {
        closed++;
      },
    },
  };
}

/** Let queued microtasks/timers run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function connected() {
  const harness = callbacks();
  const client = new CodepilotClient(harness.cb);
  const connecting = client.connect({ url: "ws://127.0.0.1:1/rpc", token: "t", cwd: "/repo" });
  await tick();
  const socket = FakeWebSocket.instances.at(-1)!;
  await tick();
  socket.reply("initialize", { protocolVersion: 1, capabilities: CAPABILITIES });
  const init = await connecting;
  return { client, socket, harness, init };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.failNext = false;
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- URL handling ---------------------------------------------------------

describe("parseServeUrl", () => {
  it("splits the token out of the URL the CLI prints", () => {
    expect(parseServeUrl("ws://127.0.0.1:4179/rpc?token=abc123")).toEqual({
      url: "ws://127.0.0.1:4179/rpc",
      token: "abc123",
    });
  });

  it("passes a bare URL through and tolerates junk", () => {
    expect(parseServeUrl(" ws://host:1/rpc ")).toEqual({ url: "ws://host:1/rpc" });
    expect(parseServeUrl("not a url")).toEqual({ url: "not a url" });
  });
});

describe("buildUrl", () => {
  it("appends the token, and leaves the URL alone without one", () => {
    expect(buildUrl("ws://h:1/rpc", "tok")).toBe("ws://h:1/rpc?token=tok");
    expect(buildUrl("ws://h:1/rpc")).toBe("ws://h:1/rpc");
  });
});

describe("describeError", () => {
  it("explains SessionNotFound, which is the common post-restart failure", () => {
    expect(describeError(new RpcError(-32000, "session not found: s1"))).toMatch(
      /may have restarted/,
    );
  });

  it("passes other messages through", () => {
    expect(describeError(new RpcError(-32602, "bad params"))).toBe("bad params");
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain")).toBe("plain");
  });
});

// --- Connection lifecycle -------------------------------------------------

describe("CodepilotClient", () => {
  it("initializes and exposes the server's capabilities", async () => {
    const { client, socket, init } = await connected();
    expect(init.capabilities.modes).toEqual(["chat", "plan", "agent"]);
    expect(client.connected).toBe(true);
    expect(client.tools).toEqual(["bash", "read_file"]);
    expect(socket.url).toBe("ws://127.0.0.1:1/rpc?token=t");
    const req = socket.lastRequest("initialize")!;
    expect(req.params).toMatchObject({
      protocolVersion: 1,
      cwd: "/repo",
      permissionMode: "ask",
    });
  });

  it("reports a handshake failure with actionable advice", async () => {
    FakeWebSocket.failNext = true;
    const harness = callbacks();
    const client = new CodepilotClient(harness.cb);
    const attempt = client.connect({ url: "ws://127.0.0.1:1/rpc", cwd: "/repo" });
    await tick();
    FakeWebSocket.instances.at(-1)!.failHandshake();
    await expect(attempt).rejects.toThrow(/token matches|origin is allowed/);
    expect(client.connected).toBe(false);
  });

  it("forwards event notifications to the UI", async () => {
    const { socket, harness } = await connected();
    socket.deliver({
      jsonrpc: "2.0",
      method: "event",
      params: {
        sessionId: "s1",
        event: { type: "message_delta", messageId: "m1", delta: { type: "text", text: "hi" } },
      },
    });
    await tick();
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({ sessionId: "s1" });
  });

  it("surfaces a permission request and answers the reverse request immediately", async () => {
    const { client, socket, harness } = await connected();
    socket.deliver({
      jsonrpc: "2.0",
      id: 99,
      method: "permission/request",
      params: {
        sessionId: "s1",
        requestId: "s1#r1",
        toolName: "bash",
        input: { command: "rm -rf build" },
        reason: "destructive",
      },
    });
    await tick();
    expect(harness.permissions[0]).toMatchObject({ requestId: "s1#r1", toolName: "bash" });
    // The dialog decides later; the reverse request itself is acknowledged now
    // so the server is not left waiting on the transport.
    const ack = socket.requests().find((m) => m.id === 99);
    expect(ack).toMatchObject({ result: {} });

    const responded = client.respondPermission("s1#r1", "allow");
    await tick();
    socket.reply("permission/respond", {});
    await responded;
    expect(socket.lastRequest("permission/respond")?.params).toEqual({
      requestId: "s1#r1",
      decision: "allow",
    });
  });

  it("surfaces a question request", async () => {
    const { socket, harness } = await connected();
    socket.deliver({
      jsonrpc: "2.0",
      id: 77,
      method: "question/request",
      params: {
        sessionId: "s1",
        requestId: "s1#q1",
        questions: [{ id: "confirm", question: "Proceed?", options: [{ label: "Yes" }] }],
      },
    });
    await tick();
    expect(harness.questions[0]?.questions[0]?.id).toBe("confirm");
    expect(socket.requests().find((m) => m.id === 77)).toMatchObject({ result: {} });
  });

  it("notifies onClose when the socket drops", async () => {
    const { socket, harness, client } = await connected();
    socket.close();
    await tick();
    expect(harness.closedCount()).toBeGreaterThanOrEqual(1);
    expect(client.connected).toBe(false);
  });

  it("refuses calls while disconnected instead of hanging", async () => {
    const harness = callbacks();
    const client = new CodepilotClient(harness.cb);
    await expect(client.send("s1", "hi")).rejects.toThrow(/not connected/);
  });

  it("maps the session methods onto the wire", async () => {
    const { client, socket } = await connected();

    const newSession = client.newSession({ cwd: "/repo", agentMode: "plan" });
    await tick();
    socket.reply("session/new", { sessionId: "s1" });
    expect(await newSession).toBe("s1");

    const list = client.listSessions();
    await tick();
    socket.reply("session/list", { sessions: [{ id: "s1", title: "t", updatedAt: 1, cwd: "/repo" }] });
    expect(await list).toHaveLength(1);

    const resume = client.resumeSession("s1");
    await tick();
    socket.reply("session/resume", { sessionId: "s1", events: [] });
    expect(await resume).toMatchObject({ sessionId: "s1" });

    const fork = client.fork("s1", 3);
    await tick();
    socket.reply("session/fork", { sessionId: "s2" });
    expect(await fork).toBe("s2");
    expect(socket.lastRequest("session/fork")?.params).toEqual({
      sessionId: "s1",
      atEventIndex: 3,
    });

    const mode = client.setMode("s1", "chat");
    await tick();
    socket.reply("session/setMode", {});
    await mode;

    const cancel = client.cancel("s1");
    await tick();
    socket.reply("prompt/cancel", {});
    await cancel;
  });

  it("propagates a server-side RPC error", async () => {
    const { client, socket } = await connected();
    const pending = client.send("gone", "hi");
    await tick();
    socket.replyError("prompt/send", -32000, "session not found: gone");
    await expect(pending).rejects.toThrow(/session not found/);
  });

  it("disconnect closes the socket and is safe to repeat", async () => {
    const { client, socket } = await connected();
    await client.disconnect();
    expect(socket.readyState).toBe(3);
    await client.disconnect();
    expect(client.connected).toBe(false);
  });
});

// --- Transport ------------------------------------------------------------

describe("automatic reconnect", () => {
  /** Open a client under fake timers and complete the initialize handshake. */
  async function connectFake(cb: ConstructorParameters<typeof CodepilotClient>[0]) {
    const client = new CodepilotClient(cb);
    const connecting = client.connect({ url: "ws://127.0.0.1:1/rpc", token: "t", cwd: "/repo" });
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances.at(-1)!;
    await vi.advanceTimersByTimeAsync(0);
    socket.reply("initialize", { protocolVersion: 1, capabilities: CAPABILITIES });
    await connecting;
    await vi.advanceTimersByTimeAsync(0);
    return { client, socket };
  }

  it("reconnects after a drop, re-initializes, and reports the attempt", async () => {
    vi.useFakeTimers();
    try {
      const reconnected: number[] = [];
      const attempts: number[] = [];
      const harness = callbacks();
      const { client, socket: first } = await connectFake({
        ...harness.cb,
        onReconnecting: (attempt: number) => void attempts.push(attempt),
        onReconnected: () => void reconnected.push(1),
      });

      // Drop the transport without a manual disconnect.
      first.close();
      expect(attempts).toEqual([1]);

      // The drop schedules a 1s reconnect; `connect()` first awaits the old
      // transport teardown (microtasks) before dialing, so run microtasks
      // until the replacement socket actually exists.
      let second: FakeWebSocket | undefined;
      for (let elapsed = 0; elapsed < 5000 && !second; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50);
        const latest = FakeWebSocket.instances.at(-1)!;
        if (latest !== first) second = latest;
      }
      expect(second).toBeDefined();
      for (let i = 0; i < 100 && second!.sent.length === 0; i++) await vi.advanceTimersByTimeAsync(1);
      second!.reply("initialize", { protocolVersion: 1, capabilities: CAPABILITIES });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconnected).toEqual([1]);
      expect(client.connected).toBe(true);
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after a manual disconnect", async () => {
    vi.useFakeTimers();
    try {
      const harness = callbacks();
      const { client, socket } = await connectFake(harness.cb);
      await client.disconnect();
      socket.close();
      await vi.advanceTimersByTimeAsync(60000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying with backoff when the server is still down", async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      const harness = callbacks();
      const { client, socket: first } = await connectFake({
        ...harness.cb,
        onReconnecting: (attempt: number) => void attempts.push(attempt),
      });

      first.close();
      FakeWebSocket.failNext = true;
      // First retry: the socket is created, then fails its handshake, which
      // starts the next backoff (attempt 2 at 2s).
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeWebSocket.instances).toHaveLength(2);
      const second = FakeWebSocket.instances.at(-1)!;
      second.failHandshake();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual([1, 2]);
      // After the 2s backoff a third socket is attempted.
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeWebSocket.instances).toHaveLength(3);
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BrowserWebSocketTransport", () => {
  it("splits batched documents and reports EOF after draining", async () => {
    const socket = new FakeWebSocket("ws://x/rpc");
    const transport = new BrowserWebSocketTransport(socket as never);

    socket.deliver({ a: 1 });
    expect(await transport.readLine()).toBe('{"a":1}');

    // A pending read is resolved by the next frame.
    const pending = transport.readLine();
    socket.deliver({ b: 2 });
    expect(await pending).toBe('{"b":2}');

    // Buffered lines are delivered before EOF.
    socket.deliver({ c: 3 });
    socket.close();
    expect(await transport.readLine()).toBe('{"c":3}');
    expect(await transport.readLine()).toBeNull();
  });

  it("strips the NDJSON newline on write and refuses writes after close", () => {
    const socket = new FakeWebSocket("ws://x/rpc");
    const transport = new BrowserWebSocketTransport(socket as never);
    transport.write('{"x":1}\n');
    expect(socket.sent).toEqual(['{"x":1}']);
    transport.close();
    expect(() => transport.write("{}")).toThrow(/closed/);
  });

  it("ignores non-text frames instead of feeding them to the parser", async () => {
    const socket = new FakeWebSocket("ws://x/rpc");
    const transport = new BrowserWebSocketTransport(socket as never);
    const pending = transport.readLine();
    socket.deliverBinary();
    socket.deliver({ ok: true });
    // The binary frame is skipped, so the first line read is the JSON one.
    expect(await pending).toBe('{"ok":true}');
  });
});
