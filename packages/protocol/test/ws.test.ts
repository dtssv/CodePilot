/**
 * WebSocket transport + server (ROADMAP-NEXT §4.3 Phase 1).
 *
 * `@codepilot/core` is mocked (same fake session as server.test.ts) so these
 * tests exercise the real HTTP upgrade path, the real `ws` framing, and the
 * real access checks without touching a provider.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mock @codepilot/core -------------------------------------------------
type Listener = (e: unknown) => void;

class FakeSession {
  id: string;
  cwd: string;
  events: unknown[] = [];
  listeners = new Set<Listener>();
  disposeCount = 0;
  static counter = 0;

  constructor(opts: { cwd: string; id?: string }) {
    this.id = opts.id ?? `ws-s${++FakeSession.counter}`;
    this.cwd = opts.cwd;
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getEvents(): unknown[] {
    return [...this.events];
  }
  emit(e: unknown): void {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
  async prompt(text: string): Promise<void> {
    this.emit({
      type: "message",
      id: "m1",
      role: "assistant",
      content: [{ type: "text", text: `echo:${text}` }],
    });
  }
  cancel(): void {}
  async dispose(): Promise<void> {
    this.disposeCount++;
    this.listeners.clear();
  }
}

const sessionsById = new Map<string, FakeSession>();

vi.mock("@codepilot/core", () => ({
  createSession: vi.fn(async (opts: { cwd: string; sessionId?: string }) => {
    const existing = opts.sessionId ? sessionsById.get(opts.sessionId) : undefined;
    if (existing) return existing;
    const s = new FakeSession({ cwd: opts.cwd });
    sessionsById.set(s.id, s);
    return s;
  }),
  listSessions: vi.fn(async () => []),
  loadConfig: vi.fn(async () => undefined),
  runGoal: vi.fn(),
}));

import {
  startWebSocketServer,
  WebSocketTransport,
  checkUpgrade,
  originAllowed,
  type WebSocketServerHandle,
} from "../src/ws.js";
import { Peer, RpcError } from "../src/rpc.js";
import { PROTOCOL_VERSION, type InitializeResult } from "../src/server.js";

// --- Helpers --------------------------------------------------------------

const servers: WebSocketServerHandle[] = [];
const clients: Peer[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  sessionsById.clear();
});

async function serve(
  opts: Parameters<typeof startWebSocketServer>[0] = {},
): Promise<WebSocketServerHandle> {
  const handle = await startWebSocketServer({ defaultCwd: "/tmp", ...opts });
  servers.push(handle);
  return handle;
}

/** Open a client peer over the same WebSocket transport the server uses. */
async function connect(
  url: string,
  opts: { origin?: string; headers?: Record<string, string> } = {},
): Promise<Peer> {
  const socket = new WebSocket(url, {
    origin: opts.origin,
    headers: opts.headers,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const peer = new Peer({ transport: new WebSocketTransport(socket), debug: false });
  void peer.loopDone.catch(() => {});
  clients.push(peer);
  return peer;
}

function connectError(
  url: string,
  opts: { origin?: string } = {},
): Promise<Error> {
  const socket = new WebSocket(url, { origin: opts.origin });
  return new Promise<Error>((resolve, reject) => {
    socket.once("error", resolve);
    socket.once("open", () => {
      socket.close();
      reject(new Error("expected the upgrade to be rejected"));
    });
  });
}

async function initialize(peer: Peer): Promise<InitializeResult> {
  return peer.request<unknown, InitializeResult>("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    cwd: "/tmp",
    permissionMode: "ask",
    clientInfo: { name: "test", version: "1" },
  });
}

/** Collect `event` notifications for a session. */
function collectEvents(peer: Peer): unknown[] {
  const out: unknown[] = [];
  peer.onNotification<{ sessionId: string; event: unknown }>("event", (p) => {
    out.push(p.event);
  });
  return out;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// --- Access checks (pure) -------------------------------------------------

describe("originAllowed", () => {
  it("allows requests with no Origin (non-browser clients)", () => {
    // The TUI, curl and the test suite send no Origin; a web page always
    // does. Blocking the absent case would break every non-browser client.
    expect(originAllowed(undefined, undefined, 1234)).toBe(true);
    expect(originAllowed("", undefined, 1234)).toBe(true);
    expect(originAllowed("null", undefined, 1234)).toBe(true);
  });

  it("allows localhost on the server's own port", () => {
    expect(originAllowed("http://localhost:1234", undefined, 1234)).toBe(true);
    expect(originAllowed("http://127.0.0.1:1234", undefined, 1234)).toBe(true);
  });

  it("rejects other browser origins, including a different port", () => {
    expect(originAllowed("http://localhost:5173", undefined, 1234)).toBe(false);
    expect(originAllowed("https://evil.example", undefined, 1234)).toBe(false);
    // Substring tricks must not pass.
    expect(originAllowed("http://localhost:1234.evil.example", undefined, 1234)).toBe(false);
  });

  it("honours an explicit allowlist and the wildcard", () => {
    expect(originAllowed("http://localhost:5173", ["http://localhost:5173"], 1234)).toBe(true);
    expect(originAllowed("https://evil.example", ["*"], 1234)).toBe(true);
  });
});

describe("checkUpgrade", () => {
  const req = (headers: Record<string, string>, url = "/rpc"): IncomingMessage =>
    ({ headers, url }) as unknown as IncomingMessage;

  it("accepts a bearer token and a query token", () => {
    expect(checkUpgrade(req({ authorization: "Bearer t0k" }), { token: "t0k", port: 1, atCapacity: false })).toEqual({ ok: true });
    expect(checkUpgrade(req({}, "/rpc?token=t0k"), { token: "t0k", port: 1, atCapacity: false })).toEqual({ ok: true });
  });

  it("rejects a missing or wrong token with 401", () => {
    expect(checkUpgrade(req({}), { token: "t0k", port: 1, atCapacity: false })).toMatchObject({ ok: false, status: 401 });
    expect(checkUpgrade(req({}, "/rpc?token=nope"), { token: "t0k", port: 1, atCapacity: false })).toMatchObject({ ok: false, status: 401 });
    // A prefix of the real token must not pass.
    expect(checkUpgrade(req({}, "/rpc?token=t0"), { token: "t0k", port: 1, atCapacity: false })).toMatchObject({ ok: false, status: 401 });
  });

  it("checks the origin before the token", () => {
    // Order matters: a malicious page should not be able to probe token
    // validity, so the origin verdict wins even with a correct token.
    const verdict = checkUpgrade(
      req({ origin: "https://evil.example", authorization: "Bearer t0k" }),
      { token: "t0k", port: 1, atCapacity: false },
    );
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects at capacity with 503", () => {
    expect(checkUpgrade(req({}), { port: 1, atCapacity: true })).toMatchObject({ ok: false, status: 503 });
  });

  it("skips the token check when auth is disabled", () => {
    expect(checkUpgrade(req({}), { port: 1, atCapacity: false })).toEqual({ ok: true });
  });
});

// --- Transport ------------------------------------------------------------

describe("WebSocketTransport", () => {
  it("queues messages and reports EOF after the queue drains", async () => {
    // A fake socket standing in for `ws`: enough to drive the transport's
    // queue/waiter logic deterministically.
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const fake = {
      on(event: string, cb: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return fake;
      },
      send: vi.fn(),
      close: vi.fn(),
    };
    const fire = (event: string, ...args: unknown[]): void => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    };
    const transport = new WebSocketTransport(fake as never);

    fire("message", Buffer.from('{"a":1}\n{"b":2}'), false);
    expect(await transport.readLine()).toBe('{"a":1}');

    // A pending read is resolved by the next inbound frame.
    const pending = transport.readLine();
    expect(await pending).toBe('{"b":2}');

    // Binary frames are ignored rather than fed to the JSON parser.
    fire("message", Buffer.from("\u0000\u0001"), true);

    // Close delivers buffered lines first, then EOF.
    fire("message", Buffer.from('{"c":3}'), false);
    fire("close");
    expect(await transport.readLine()).toBe('{"c":3}');
    expect(await transport.readLine()).toBeNull();

    // Writes strip the NDJSON newline — WebSocket already frames messages.
    const t2 = new WebSocketTransport(fake as never);
    t2.write('{"x":1}\n');
    expect(fake.send).toHaveBeenCalledWith('{"x":1}');
  });
});

// --- End to end -----------------------------------------------------------

describe("startWebSocketServer", () => {
  it("serves the protocol to a token-bearing client", async () => {
    const handle = await serve();
    expect(handle.token).toMatch(/^[0-9a-f]{48}$/);
    expect(handle.url).toContain(`token=${handle.token}`);

    const peer = await connect(handle.url);
    const init = await initialize(peer);
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.capabilities.modes).toEqual(["chat", "plan", "agent"]);

    const events = collectEvents(peer);
    const { sessionId } = await peer.request<unknown, { sessionId: string }>(
      "session/new",
      { cwd: "/tmp" },
    );
    await peer.request("prompt/send", { sessionId, text: "hello" });
    await waitFor(() => events.length > 0);
    expect(JSON.stringify(events)).toContain("echo:hello");
  });

  it("accepts the token as an Authorization header", async () => {
    const handle = await serve();
    const peer = await connect(`ws://${handle.host}:${handle.port}/rpc`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    await expect(initialize(peer)).resolves.toBeTruthy();
  });

  it("rejects a wrong token with 401 before any session exists", async () => {
    const handle = await serve();
    const err = await connectError(`ws://${handle.host}:${handle.port}/rpc?token=wrong`);
    expect(err.message).toMatch(/401/);
    expect(handle.connectionCount()).toBe(0);
  });

  it("rejects a foreign browser origin with 403", async () => {
    const handle = await serve();
    const err = await connectError(handle.url, { origin: "https://evil.example" });
    expect(err.message).toMatch(/403/);
    expect(handle.connectionCount()).toBe(0);
  });

  it("accepts an explicitly allowed origin", async () => {
    const handle = await serve({ allowedOrigins: ["http://localhost:5173"] });
    const peer = await connect(handle.url, { origin: "http://localhost:5173" });
    await expect(initialize(peer)).resolves.toBeTruthy();
  });

  it("refuses connections past maxConnections with 503", async () => {
    const handle = await serve({ maxConnections: 1 });
    await connect(handle.url);
    await waitFor(() => handle.connectionCount() === 1);
    const err = await connectError(handle.url);
    expect(err.message).toMatch(/503/);
    expect(handle.connectionCount()).toBe(1);
  });

  it("disposes a client's sessions when its socket drops", async () => {
    // The point of the test: a browser tab can vanish without calling
    // `shutdown`, and its sessions must not keep running unattended.
    const handle = await serve();
    const peer = await connect(handle.url);
    await initialize(peer);
    const { sessionId } = await peer.request<unknown, { sessionId: string }>(
      "session/new",
      { cwd: "/tmp" },
    );
    const session = sessionsById.get(sessionId)!;
    expect(session.disposeCount).toBe(0);

    await peer.close();
    await waitFor(() => session.disposeCount === 1);
    await waitFor(() => handle.connectionCount() === 0);
    expect(session.listeners.size).toBe(0);
  });

  it("keeps each connection's sessions private", async () => {
    const handle = await serve();
    const a = await connect(handle.url);
    const b = await connect(handle.url);
    await initialize(a);
    await initialize(b);
    const { sessionId } = await a.request<unknown, { sessionId: string }>(
      "session/new",
      { cwd: "/tmp" },
    );
    // b never opened that session, so it cannot prompt it.
    await expect(b.request("prompt/send", { sessionId, text: "hi" })).rejects.toThrow(
      RpcError,
    );
    await expect(a.request("prompt/send", { sessionId, text: "hi" })).resolves.toEqual({});
  });

  it("answers a plain HTTP request with 426 Upgrade Required", async () => {
    const handle = await serve({ auth: "none" });
    const res = await fetch(`http://${handle.host}:${handle.port}/`);
    expect(res.status).toBe(426);
    expect(await res.text()).toMatch(/WebSocket upgrade/);
  });

  it("drops a socket that stops answering pings", async () => {
    const handle = await serve({ auth: "none", heartbeatMs: 20 });
    const socket = new WebSocket(handle.url);
    await new Promise<void>((r) => socket.once("open", () => r()));
    await waitFor(() => handle.connectionCount() === 1);
    // `ws` auto-pongs inside WebSocket.pong(); stubbing it simulates a tab
    // whose process is gone but whose socket is still half-open.
    socket.pong = () => {};
    await waitFor(() => handle.connectionCount() === 0, 3000);
  });

  it("close() tears down listeners and live connections", async () => {
    const handle = await serve({ auth: "none" });
    const peer = await connect(handle.url);
    await initialize(peer);
    await handle.close();
    expect(handle.connectionCount()).toBe(0);
    await expect(
      fetch(`http://${handle.host}:${handle.port}/`).then(() => "reachable"),
    ).rejects.toThrow();
  });
});

// --- Static SPA hosting (serve --web --web-root, §4.3 Phase 4) -------------

describe("static SPA hosting", () => {
  it("serves index.html at / with no-cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "codepilot-webroot-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<html>spa</html>", "utf-8");
    writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)", "utf-8");
    try {
      const handle = await serve({ auth: "none", staticRoot: root });
      const res = await fetch(`http://${handle.host}:${handle.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toBe("<html>spa</html>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves fingerprinted assets with immutable caching", async () => {
    const root = mkdtempSync(join(tmpdir(), "codepilot-webroot-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<html></html>", "utf-8");
    writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)", "utf-8");
    try {
      const handle = await serve({ auth: "none", staticRoot: root });
      const res = await fetch(
        `http://${handle.host}:${handle.port}/assets/app-abc123.js`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/javascript/);
      expect(res.headers.get("cache-control")).toMatch(/immutable/);
      expect(await res.text()).toBe("console.log(1)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to index.html for extensionless client-side routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "codepilot-webroot-"));
    writeFileSync(join(root, "index.html"), "<html>spa</html>", "utf-8");
    try {
      const handle = await serve({ auth: "none", staticRoot: root });
      const res = await fetch(`http://${handle.host}:${handle.port}/sessions/abc`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>spa</html>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns 404 for missing files that have an extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "codepilot-webroot-"));
    writeFileSync(join(root, "index.html"), "<html></html>", "utf-8");
    try {
      const handle = await serve({ auth: "none", staticRoot: root });
      const res = await fetch(`http://${handle.host}:${handle.port}/missing.js`);
      expect(res.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects path traversal outside the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "codepilot-webroot-"));
    writeFileSync(join(root, "index.html"), "<html></html>", "utf-8");
    try {
      const handle = await serve({ auth: "none", staticRoot: root });
      // Encoded traversal — decodeURIComponent runs before normalization.
      const res = await fetch(
        `http://${handle.host}:${handle.port}/..%2F..%2Fetc%2Fpasswd`,
      );
      expect([403, 404]).toContain(res.status);
      const body = await res.text();
      expect(body).not.toMatch(/root:.*:0:0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps WebSocket upgrades working alongside static hosting", async () => {
    const root = mkdtempSync(join(tmpdir(), "codepilot-webroot-"));
    writeFileSync(join(root, "index.html"), "<html></html>", "utf-8");
    try {
      const handle = await serve({ auth: "none", staticRoot: root });
      const peer = await connect(handle.url);
      await initialize(peer);
      expect(handle.connectionCount()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("without staticRoot, GET still answers 426", async () => {
    const handle = await serve({ auth: "none" });
    const res = await fetch(`http://${handle.host}:${handle.port}/`);
    expect(res.status).toBe(426);
  });
});
