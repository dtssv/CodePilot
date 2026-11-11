// Opt-in inbound channels: an allowlisted MCP server notification is delivered
// into the session as a synthesized message. These tests cover the two layers:
//   1. McpManager.setNotificationHandler fans server notifications (that the
//      client does not act on internally) out to registered handlers, with an
//      unregister fn (so a disposed session detaches).
//   2. inboundNotificationAllowed / formatInboundNotification shape the policy
//      and the rendered message.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpManager } from "../src/mcp.js";
import {
  inboundNotificationAllowed,
  formatInboundNotification,
} from "../src/session-mcp.js";

/** A mock MCP server that, on a `tools/call` to `ping`, sends a server
 * notification (`notifications/message`) BEFORE the tool result. The
 * notification is not one the client acts on internally, so it reaches the
 * consumer's notification handler. */
function writeNotifyingServer(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-notif-"));
  const path = join(dir, "server.mjs");
  const body = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // ignore notifications from the client
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' }, capabilities: {} } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (msg.method === 'resources/list' || msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'resources/list' ? { resources: [] } : { prompts: [] } });
  } else if (msg.method === 'tools/call') {
    // Emit a (non-internal) server notification, then answer the call.
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', text: 'hello' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`;
  writeFileSync(path, body, "utf-8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("inboundNotificationAllowed", () => {
  it("matches by server:method, bare method, or bare server; empty allows nothing", () => {
    expect(inboundNotificationAllowed([], "s", "notifications/message")).toBe(false);
    expect(inboundNotificationAllowed(["s:notifications/message"], "s", "notifications/message")).toBe(true);
    expect(inboundNotificationAllowed(["notifications/message"], "s", "notifications/message")).toBe(true);
    expect(inboundNotificationAllowed(["s"], "s", "notifications/message")).toBe(true);
    expect(inboundNotificationAllowed(["other"], "s", "notifications/message")).toBe(false);
    expect(inboundNotificationAllowed(["s:other"], "s", "notifications/message")).toBe(false);
  });
});

describe("formatInboundNotification", () => {
  it("renders server + method and includes serialized params", () => {
    const msg = formatInboundNotification("github", "notifications/message", { text: "hi" });
    expect(msg).toContain('"github"');
    expect(msg).toContain("notifications/message");
    expect(msg).toContain('{"text":"hi"}');
  });
  it("omits empty/absent params and truncates oversized payloads", () => {
    expect(formatInboundNotification("s", "m", undefined)).not.toContain("\n");
    expect(formatInboundNotification("s", "m", {})).not.toContain("\n");
    const big = { blob: "x".repeat(5000) };
    const out = formatInboundNotification("s", "m", big);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(1100);
  });
});

describe("McpManager notification fan-out", () => {
  it("delivers a server notification to a registered handler and stops after unregister", async () => {
    const mock = writeNotifyingServer();
    const mgr = new McpManager({ mock: { command: process.execPath, args: [mock.path] } });
    try {
      await mgr.startAll();
      const seen: Array<{ server: string; method: string; params: unknown }> = [];
      const unregister = mgr.setNotificationHandler((server, method, params) => {
        seen.push({ server, method, params });
      });

      await mgr.invoke("mock", "ping", {});
      // Give the notification (sent before the result) a tick to be dispatched.
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0].server).toBe("mock");
      expect(seen[0].method).toBe("notifications/message");
      expect(seen[0].params).toEqual({ level: "info", text: "hello" });

      // After unregister, a further notification is not delivered.
      unregister();
      const before = seen.length;
      await mgr.invoke("mock", "ping", {});
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.length).toBe(before);
    } finally {
      await mgr.stopAll().catch(() => {});
      mock.cleanup();
    }
  });

  it("does NOT forward internally-handled list_changed notifications to the handler", async () => {
    const mock = writeNotifyingServer();
    const mgr = new McpManager({ mock: { command: process.execPath, args: [mock.path] } });
    try {
      await mgr.startAll();
      const methods: string[] = [];
      mgr.setNotificationHandler((_s, method) => methods.push(method));
      await mgr.invoke("mock", "ping", {});
      await new Promise((r) => setTimeout(r, 50));
      // Only the non-internal notification is forwarded.
      expect(methods).toContain("notifications/message");
      expect(methods).not.toContain("notifications/tools/list_changed");
    } finally {
      await mgr.stopAll().catch(() => {});
      mock.cleanup();
    }
  });
});
