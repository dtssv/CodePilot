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

  it("seeds the model from the session endpoint on connect (not 'no model yet')", async () => {
    // First client: fresh session, pin a model on it.
    const a = await RemoteSession.connect({
      url: server.url,
      cwd: process.cwd(),
      ...noopBridges,
    });
    await a.setModel("test-model-xyz");
    expect(a.getModel()).toBe("test-model-xyz");

    // Second client ATTACHES to the same session id. It must seed its model
    // from the session's resolved endpoint, not show an empty model.
    const b = await RemoteSession.connect({
      url: server.url,
      cwd: process.cwd(),
      sessionId: a.id,
      ...noopBridges,
    });
    expect(b.getModel()).toBe("test-model-xyz");

    await a.dispose();
    await b.dispose();
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

  it("gives up after a bounded number of attempts when the server stays down", async () => {
    const banners: string[] = [];
    const remote = await RemoteSession.connect({
      url: server.url,
      cwd: process.cwd(),
      ...noopBridges,
      reconnectMaxAttempts: 3,
      reconnectBackoffMs: 5,
    });
    // Collect the transcript error banners (the "Still trying…" / give-up boxes).
    remote.subscribe((e) => {
      if ((e as { type?: string }).type === "error") {
        banners.push((e as { message: string }).message);
      }
    });

    // Take the server down so every reconnect attempt fails, then drop the
    // socket to trigger the auto-reconnect loop.
    await server.close();
    remote.__dropSocketForTest();

    // The loop exhausts its attempts and goes quiet.
    await waitFor(() => banners.some((m) => m.includes("gave up auto-reconnecting")), 5000);

    // It must NOT spam one "Still trying…" box per attempt — at most one.
    const stillTrying = banners.filter((m) => m.includes("Still trying to reach"));
    expect(stillTrying.length).toBeLessThanOrEqual(1);
    const gaveUp = banners.filter((m) => m.includes("gave up auto-reconnecting"));
    expect(gaveUp.length).toBe(1);

    // After giving up it stays quiet (no further banners accumulate).
    const count = banners.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(banners.length).toBe(count);

    await remote.dispose();
  });
});
