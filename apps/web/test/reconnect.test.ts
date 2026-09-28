// Integration: CodepilotClient automatic reconnect against the REAL
// WebSocket server from @codepilot/protocol. A real server socket is
// terminated mid-session; the client must redial, re-initialize, and fire
// onReconnected — without a manual reconnect call.
//
// `ws` is not a dependency of this package (the browser uses the native
// WebSocket), so it is resolved through @codepilot/protocol, which has it.

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWebSocketServer, type WebSocketServerHandle } from "@codepilot/protocol/ws";
import { CodepilotClient } from "../src/protocol/client.js";

// Resolve `ws` through the protocol package (its dependency), since the web
// package itself must not take a Node-only dep that could leak into the bundle.
const protocolReal = realpathSync(join(import.meta.dirname, "../node_modules/@codepilot/protocol"));
const protocolRequire = createRequire(join(protocolReal, "dist", "index.js"));
interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, fn: (...args: never[]) => void): void;
}
interface WsConstructor { new (url: string): WsSocket }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WS = protocolRequire("ws") as WsConstructor;

/** Bridge a `ws` client socket to the browser WebSocket surface the client uses. */
function wsToBrowserSocket(socket: WsSocket): WebSocket {
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  const browserLike = {
    readyState: 0,
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    send(data: string) { socket.send(data); },
    close(code?: number, reason?: string) { socket.close(code, reason); },
  };
  const emit = (type: string, ev: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(ev);
  };
  socket.on("open", () => { browserLike.readyState = 1; emit("open", {}); });
  socket.on("message", (data: unknown, isBinary: boolean) => {
    emit("message", { data: isBinary ? data : String(data) });
  });
  socket.on("close", () => { browserLike.readyState = 3; emit("close", {}); });
  socket.on("error", () => emit("error", {}));
  return browserLike as unknown as WebSocket;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("CodepilotClient reconnect against a real server", () => {
  let server: WebSocketServerHandle;

  beforeEach(async () => {
    server = await startWebSocketServer({
      port: 0,
      auth: "none",
      defaultCwd: process.cwd(),
      allowedOrigins: ["*"],
    } as never);
  });

  afterEach(async () => {
    await server.close().catch(() => {});
    vi.unstubAllGlobals();
  });

  it("redials and re-initializes after the server drops the socket", async () => {
    const reconnecting: number[] = [];
    let reconnected = 0;
    let closed = 0;
    const sockets: WsSocket[] = [];

    vi.stubGlobal("WebSocket", class {
      static OPEN = 1;
      constructor(url: string) {
        const socket = new WS(url);
        sockets.push(socket);
        return wsToBrowserSocket(socket);
      }
    });

    const client = new CodepilotClient({
      onEvent: () => {},
      onPermission: () => {},
      onQuestion: () => {},
      onClose: () => { closed++; },
      onReconnecting: (attempt) => void reconnecting.push(attempt),
      onReconnected: () => { reconnected++; },
    });

    const init = await client.connect({ url: server.url.replace("/rpc", "/rpc"), cwd: process.cwd() });
    expect(init.capabilities.modes).toContain("agent");
    expect(sockets).toHaveLength(1);
    expect(server.connectionCount()).toBe(1);

    // Kill the transport from the client side without telling the client
    // (a crash, not a graceful close handshake).
    sockets[0].terminate();
    await tick(); await tick();

    expect(closed).toBe(1);
    expect(reconnecting).toEqual([1]);

    // First backoff is 1s. Wait generously for the redial + handshake.
    const deadline = Date.now() + 5000;
    while (reconnected === 0 && Date.now() < deadline) await tick();

    expect(reconnected).toBe(1);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(client.connected).toBe(true);
    expect(server.connectionCount()).toBe(1);
    await client.disconnect();
  }, 15000);

  it("stays down without reconnecting after a manual disconnect", async () => {
    const sockets: WsSocket[] = [];
    vi.stubGlobal("WebSocket", class {
      constructor(url: string) {
        const socket = new WS(url);
        sockets.push(socket);
        return wsToBrowserSocket(socket);
      }
    });
    const client = new CodepilotClient({
      onEvent: () => {}, onPermission: () => {}, onQuestion: () => {}, onClose: () => {},
    });
    await client.connect({ url: server.url, cwd: process.cwd() });
    await client.disconnect();
    await new Promise((r) => setTimeout(r, 1500));
    expect(sockets).toHaveLength(1);
  }, 10000);
});
