// Reverse-request routing on a SHARED McpManager.
//
// Regression for the cross-session isolation bug: the manager used to hold a
// single reverse-request handler field that each session OVERWROTE, so a
// server-initiated request (elicitation/sampling) was routed to whichever
// session registered last — and kept pointing at it even after that session
// was disposed. The manager now keeps a SET of handlers (newest preferred,
// with fallback) and `setServerRequestHandler` returns an unregister fn so a
// disposed session detaches itself.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpManager } from "../src/mcp.js";

/** A mock MCP server that, on a `tools/call` to `ask`, initiates a reverse
 * `elicitation/create` request to the client and echoes back whatever the
 * client's handler returned. */
function writeElicitingServer(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-rev-"));
  const path = join(dir, "server.mjs");
  const body = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
let nextId = 1000;
const pending = new Map();
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  // A response to our reverse request?
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
    const resolve = pending.get(msg.id); pending.delete(msg.id); resolve(msg); return;
  }
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' }, capabilities: {} } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ask', description: 'ask the user', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (msg.method === 'resources/list' || msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'resources/list' ? { resources: [] } : { prompts: [] } });
  } else if (msg.method === 'tools/call') {
    // Initiate a reverse request to the client and wait for its answer.
    const revId = nextId++;
    const answer = await new Promise((resolve) => {
      pending.set(revId, resolve);
      send({ jsonrpc: '2.0', id: revId, method: 'elicitation/create', params: { message: 'who are you?' } });
    });
    const who = answer.result && answer.result.who ? answer.result.who : 'ERR:' + JSON.stringify(answer.error);
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'answered-by:' + who }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`;
  writeFileSync(path, body, "utf-8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("McpManager reverse-request routing (shared manager)", () => {
  it("prefers the newest handler, falls back on unregister, and never routes to a removed handler", async () => {
    const mock = writeElicitingServer();
    const mgr = new McpManager({ mock: { command: process.execPath, args: [mock.path] } });
    try {
      await mgr.startAll();

      // Two sessions share this manager. Each registers its own handler —
      // previously the second would clobber the first.
      const seenA: string[] = [];
      const seenB: string[] = [];
      const unregA = mgr.setServerRequestHandler(async (_s, _m, _p) => {
        seenA.push("A");
        return { who: "session-A" };
      });
      const unregB = mgr.setServerRequestHandler(async (_s, _m, _p) => {
        seenB.push("B");
        return { who: "session-B" };
      });

      // Reverse request routes to the NEWEST registered handler (B).
      const r1 = await mgr.invoke("mock", "ask", {});
      expect(r1.content).toContain("answered-by:session-B");
      expect(seenB).toEqual(["B"]);
      expect(seenA).toEqual([]); // A was NOT clobbered-into — just not preferred

      // Session B disposes → unregister. Now the request must fall back to A,
      // NOT to the dead B.
      unregB();
      const r2 = await mgr.invoke("mock", "ask", {});
      expect(r2.content).toContain("answered-by:session-A");
      expect(seenA).toEqual(["A"]);

      // Both gone → a reverse request is refused (not hung, not misrouted).
      unregA();
      const r3 = await mgr.invoke("mock", "ask", {});
      expect(r3.content).toContain("answered-by:ERR");
    } finally {
      await mgr.stopAll().catch(() => {});
      mock.cleanup();
    }
  });

  it("routes a reverse request to the session that invoked the tool (per-call affinity)", async () => {
    const mock = writeElicitingServer();
    const mgr = new McpManager({ mock: { command: process.execPath, args: [mock.path] } });
    try {
      await mgr.startAll();

      // Two sessions share the manager. A registered first, B second (so B is
      // the "newest" and would win without affinity).
      const handlerA = async () => ({ who: "session-A" });
      const handlerB = async () => ({ who: "session-B" });
      const unregA = mgr.setServerRequestHandler(handlerA);
      const unregB = mgr.setServerRequestHandler(handlerB);

      // Session A invokes the tool, tagging the call with ITS handler. The
      // reverse request the server initiates during the call must route to A,
      // not to the newest-registered B.
      const r = await mgr.invoke("mock", "ask", {}, handlerA);
      expect(r.content).toContain("answered-by:session-A");

      unregA();
      unregB();
    } finally {
      await mgr.stopAll().catch(() => {});
      mock.cleanup();
    }
  });

  it("interleaved reverse requests land on each invoking session (two servers)", async () => {
    // Two servers, two sessions. Each session invokes on a different server;
    // each server's in-call reverse request must land on the session that
    // triggered it — even though both handlers are registered on the shared
    // manager at once and are interleaved in time.
    const mock1 = writeElicitingServer();
    const mock2 = writeElicitingServer();
    const mgr = new McpManager({
      one: { command: process.execPath, args: [mock1.path] },
      two: { command: process.execPath, args: [mock2.path] },
    });
    try {
      await mgr.startAll();

      // Barrier so both invocations are genuinely in flight at the same time
      // before either reverse request is answered.
      let releaseA: () => void = () => {};
      let releaseB: () => void = () => {};
      const gateA = new Promise<void>((res) => (releaseA = res));
      const gateB = new Promise<void>((res) => (releaseB = res));

      const handlerA = async () => {
        releaseA();
        await gateB; // wait until B is also mid-call
        return { who: "session-A" };
      };
      const handlerB = async () => {
        releaseB();
        await gateA; // wait until A is also mid-call
        return { who: "session-B" };
      };
      const unregA = mgr.setServerRequestHandler(handlerA);
      const unregB = mgr.setServerRequestHandler(handlerB);

      const [rA, rB] = await Promise.all([
        mgr.invoke("one", "ask", {}, handlerA),
        mgr.invoke("two", "ask", {}, handlerB),
      ]);

      // Despite both handlers being registered and both calls overlapping, each
      // server's reverse request routed back to the session that invoked it.
      expect(rA.content).toContain("answered-by:session-A");
      expect(rB.content).toContain("answered-by:session-B");

      unregA();
      unregB();
    } finally {
      await mgr.stopAll().catch(() => {});
      mock1.cleanup();
      mock2.cleanup();
    }
  });
});
