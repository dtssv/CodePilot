// tools/list_changed invalidation: a server that adds/removes tools mid-session
// must be re-listed. The MCP client refreshes its cached tool list on
// `notifications/tools/list_changed`, and McpManager fans the change out to a
// registered handler so the session can re-register the server's tools.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpManager } from "../src/mcp.js";

/** A mock MCP server that starts with one tool (`flip`). Calling `flip` makes
 * it switch to a second tool set (`flip` + `added`) and emit a
 * `notifications/tools/list_changed`. */
function writeFlippingServer(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-flip-"));
  const path = join(dir, "server.mjs");
  const body = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
let flipped = false;
function toolList() {
  const base = [{ name: 'flip', description: 'flip the tool set', inputSchema: { type: 'object', properties: {} } }];
  if (flipped) base.push({ name: 'added', description: 'a newly added tool', inputSchema: { type: 'object', properties: {} } });
  return base;
}
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // client notification
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' }, capabilities: { tools: { listChanged: true } } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: toolList() } });
  } else if (msg.method === 'resources/list' || msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'resources/list' ? { resources: [] } : { prompts: [] } });
  } else if (msg.method === 'tools/call') {
    if (msg.params && msg.params.name === 'flip') {
      flipped = true;
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'flipped' }] } });
      // Announce the change AFTER the call result.
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    }
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`;
  writeFileSync(path, body, "utf-8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("McpManager tools/list_changed", () => {
  it("refreshes the tool list and fires the change handler when the server adds a tool", async () => {
    const mock = writeFlippingServer();
    const mgr = new McpManager({ mock: { command: process.execPath, args: [mock.path] } });
    try {
      await mgr.startAll();

      // Initially one tool.
      expect(mgr.listAllTools().map((t) => t.name).sort()).toEqual(["flip"]);

      const changed: string[] = [];
      const unreg = mgr.setToolsChangedHandler((server) => changed.push(server));

      // Trigger the server to add a tool + emit the notification.
      await mgr.invoke("mock", "flip", {});

      // The notification arrives asynchronously after the call result; give the
      // client a moment to process it and re-list.
      for (let i = 0; i < 50 && changed.length === 0; i++) await sleep(10);

      expect(changed).toEqual(["mock"]);
      expect(mgr.listAllTools().map((t) => t.name).sort()).toEqual(["added", "flip"]);

      // After unregister, no further fan-out (and no crash).
      unreg();
    } finally {
      await mgr.stopAll().catch(() => {});
      mock.cleanup();
    }
  });
});
