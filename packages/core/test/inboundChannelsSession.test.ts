// End-to-end: an opt-in inbound channel delivers an allowlisted MCP server
// notification into a live session's steering queue as a synthesized message.
// Default off (no inboundChannels config) means the same notification is
// ignored.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/session.js";

const tempHome = process.env.HOME ?? tmpdir();

/** A mock MCP server that emits a `notifications/message` before answering a
 * `tools/call` to `ping`. */
function writeNotifyingServer(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-notif-session-"));
  const path = join(dir, "server.mjs");
  const body = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' }, capabilities: {} } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (msg.method === 'resources/list' || msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'resources/list' ? { resources: [] } : { prompts: [] } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'external-event' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`;
  writeFileSync(path, body, "utf-8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function steerQueue(session: unknown): Array<{ source: string; text: string }> {
  return (session as { steeringQueue: Array<{ source: string; text: string }> }).steeringQueue;
}

async function invokeMcpTool(session: unknown, server: string, tool: string): Promise<void> {
  // Reach the lazy MCP manager through the session; invoke a tool so the server
  // emits its notification.
  const s = session as { mcpReady: Promise<unknown>; mcp: { invoke: (a: string, b: string, c: unknown) => Promise<unknown> } | null };
  await s.mcpReady;
  await s.mcp!.invoke(server, tool, {});
}

describe("inbound channels (session end-to-end)", () => {
  let workDir: string;
  let mock: { path: string; cleanup: () => void };
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "work-inbound-"));
    mock = writeNotifyingServer();
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    mock.cleanup();
  });

  it("delivers an allowlisted notification into the steering queue when enabled", async () => {
    const session = await createSession({
      cwd: workDir,
      config: {
        mcpServers: { mock: { command: process.execPath, args: [mock.path] } },
        inboundChannels: { enabled: true, allow: ["mock:notifications/message"] },
      },
    });
    try {
      await invokeMcpTool(session, "mock", "ping");
      await new Promise((r) => setTimeout(r, 80));
      const queue = steerQueue(session);
      const notice = queue.find((i) => i.source === "system" && i.text.includes("external-event"));
      expect(notice).toBeTruthy();
      expect(notice!.text).toContain("mock");
    } finally {
      await session.dispose();
    }
  });

  it("ignores the same notification when inbound channels are off (default)", async () => {
    const session = await createSession({
      cwd: workDir,
      config: {
        mcpServers: { mock: { command: process.execPath, args: [mock.path] } },
        // no inboundChannels → default off
      },
    });
    try {
      await invokeMcpTool(session, "mock", "ping");
      await new Promise((r) => setTimeout(r, 80));
      const queue = steerQueue(session);
      expect(queue.some((i) => i.source === "system" && i.text.includes("external-event"))).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  it("ignores a notification not on the allowlist", async () => {
    const session = await createSession({
      cwd: workDir,
      config: {
        mcpServers: { mock: { command: process.execPath, args: [mock.path] } },
        inboundChannels: { enabled: true, allow: ["mock:notifications/other"] },
      },
    });
    try {
      await invokeMcpTool(session, "mock", "ping");
      await new Promise((r) => setTimeout(r, 80));
      const queue = steerQueue(session);
      expect(queue.some((i) => i.source === "system" && i.text.includes("external-event"))).toBe(false);
    } finally {
      await session.dispose();
    }
  });
});
