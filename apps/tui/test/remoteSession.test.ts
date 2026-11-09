// Integration: RemoteSession auto-reconnect against the REAL protocol
// WebSocket server. When the client's socket drops (server reaps an idle
// connection, restart, or a blip), a follow-up RPC like the /resume picker's
// session/list must self-heal by reconnecting instead of throwing
// "websocket transport closed".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWebSocketServer, type WebSocketServerHandle } from "@codepilot/protocol/ws";
import { RemoteSession } from "../src/remoteSession.js";

const noopBridges = {
  onPermissionRequest: async () => "deny" as const,
  onAskUser: async () => ({ answers: {} }) as never,
};

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("RemoteSession auto-reconnect", () => {
  let server: WebSocketServerHandle;

  beforeEach(async () => {
    server = await startWebSocketServer({
      port: 0,
      auth: "none",
      defaultCwd: process.cwd(),
      allowedOrigins: ["*"],
      heartbeatMs: 0,
    } as never);
  });

  afterEach(async () => {
    await server.close().catch(() => {});
  });

  it("recovers listSessions() after the socket drops", async () => {
    const states: string[] = [];
    const remote = await RemoteSession.connect({
      url: server.url,
      cwd: process.cwd(),
      ...noopBridges,
      onConnectionChange: (s) => states.push(s),
    });

    // Baseline call works.
    await expect(remote.listSessions()).resolves.toBeInstanceOf(Array);

    // Drop the underlying socket, as the server's heartbeat reaper would.
    remote.__dropSocketForTest();

    // The very next call must self-heal rather than throw transport-closed.
    const sessions = await remote.listSessions();
    expect(Array.isArray(sessions)).toBe(true);

    await waitFor(() => states.includes("reconnecting") && states.includes("connected"));
    expect(states).toContain("reconnecting");
    expect(states[states.length - 1]).toBe("connected");

    await remote.dispose();
  });

  it("does not reconnect after an intentional dispose", async () => {
    const states: string[] = [];
    const remote = await RemoteSession.connect({
      url: server.url,
      cwd: process.cwd(),
      ...noopBridges,
      onConnectionChange: (s) => states.push(s),
    });
    await remote.dispose();
    const before = states.length;
    // Dropping after dispose must not kick off a reconnect.
    remote.__dropSocketForTest();
    await new Promise((r) => setTimeout(r, 100));
    expect(states.length).toBe(before);
  });
});
