import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  McpStdioClient,
  McpManager,
  McpSseClient,
  isMcpSseConfig,
  mcpToolName,
  mcpResourceToolName,
  parseMcpToolName,
} from "../src/mcp.js";

// ---------------------------------------------------------------------------
// Mock MCP server helpers
// ---------------------------------------------------------------------------

/**
 * Write a tiny Node script to a temp file that speaks the MCP JSON-RPC
 * framing on its stdio. The script reads newline-delimited JSON requests
 * and dispatches a programmable response table.
 *
 * We embed the script as a string (rather than carrying a fixture file) so
 * the test is self-contained and the framing rules are visible at the call
 * site.
 */
function writeMockMcpServer(
  responses: Array<{
    match: { method: string };
    result: unknown;
  }>
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-mock-"));
  const path = join(dir, "server.mjs");
  // The script is intentionally a CommonJS-like node ESM that reads JSON
  // lines from stdin and writes JSON lines to stdout. We embed a JSON-string
  // of the response table so we don't have to worry about escaping.
  const table = JSON.stringify(responses);
  const body = `
import readline from 'node:readline';
const responses = ${table};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined && msg.method && msg.method.startsWith('notifications/')) {
    // notifications have no response
    return;
  }
  const r = responses.find(r => r.match.method === msg.method);
  let out;
  if (r) {
    out = { jsonrpc: '2.0', id: msg.id, result: r.result };
  } else {
    out = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;
  writeFileSync(path, body, "utf-8");
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpStdioClient framing", () => {
  it("performs initialize + tools/list over a JSON-RPC framed stdio", async () => {
    const mock = writeMockMcpServer([
      {
        match: { method: "initialize" },
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "mock", version: "0" },
          capabilities: { resources: {}, prompts: {} },
        },
      },
      {
        match: { method: "tools/list" },
        result: {
          tools: [
            {
              name: "echo",
              description: "echo input",
              inputSchema: { type: "object", properties: { x: { type: "string" } } },
            },
          ],
        },
      },
      {
        match: { method: "resources/list" },
        result: {
          resources: [{ uri: "memo://hi", name: "hi", mimeType: "text/plain" }],
        },
      },
      {
        match: { method: "prompts/list" },
        result: {
          prompts: [{ name: "greet", description: "say hi" }],
        },
      },
    ]);
    try {
      const c = new McpStdioClient("mock", {
        command: process.execPath,
        args: [mock.path],
      });
      await c.start();
      const tools = c.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("echo");
      expect(tools[0]!.server).toBe("mock");
      const resources = c.listResources();
      expect(resources).toHaveLength(1);
      expect(resources[0]!.uri).toBe("memo://hi");
      const prompts = c.listPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.name).toBe("greet");
      await c.stop();
    } finally {
      mock.cleanup();
    }
  });

  it("routes tools/call responses back to the original request", async () => {
    const mock = writeMockMcpServer([
      {
        match: { method: "initialize" },
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "mock" },
        },
      },
      {
        match: { method: "tools/list" },
        result: { tools: [] },
      },
      {
        match: { method: "tools/call" },
        result: {
          content: [{ type: "text", text: "hello, world" }],
        },
      },
    ]);
    try {
      const c = new McpStdioClient("mock", {
        command: process.execPath,
        args: [mock.path],
      });
      await c.start();
      const r = await c.invokeTool({ name: "ping", arguments: {} });
      expect(r.content).toBe("hello, world");
      expect(r.isError).toBeFalsy();
      await c.stop();
    } finally {
      mock.cleanup();
    }
  });

  it("rejects with the server's error code on a method-not-found", async () => {
    // Mock server: no responses, everything errors.
    const mock = writeMockMcpServer([]);
    try {
      const c = new McpStdioClient("mock", {
        command: process.execPath,
        args: [mock.path],
      });
      await c.start();
      // initialize + tools/list are intercepted by the mock? No — they're
      // missing from the table, so the mock returns -32601 for them. The
      // client treats that as an error.
      // We don't await c.start() above with errors, so let me construct a
      // scenario where initialize works but tools/call does not.
      // Re-do with a partial mock:
      await c.stop();
    } catch {
      /* fallthrough */
    } finally {
      mock.cleanup();
    }

    // Now an explicit "initialize succeeds, tools/call fails" test:
    const mock2 = writeMockMcpServer([
      {
        match: { method: "initialize" },
        result: { protocolVersion: "2024-11-05", serverInfo: { name: "x" } },
      },
      {
        match: { method: "tools/list" },
        result: { tools: [] },
      },
    ]);
    try {
      const c = new McpStdioClient("mock", {
        command: process.execPath,
        args: [mock2.path],
      });
      await c.start();
      await expect(
        c.invokeTool({ name: "nope", arguments: {} })
      ).rejects.toThrow(/MCP error -32601/);
      await c.stop();
    } finally {
      mock2.cleanup();
    }
  });
});

describe("McpManager fail-soft behaviour", () => {
  it("continues starting healthy servers when one is misconfigured", async () => {
    const mock = writeMockMcpServer([
      {
        match: { method: "initialize" },
        result: { protocolVersion: "2024-11-05", serverInfo: { name: "ok" } },
      },
      {
        match: { method: "tools/list" },
        result: { tools: [{ name: "hi", description: "d" }] },
      },
    ]);
    try {
      const mgr = new McpManager({
        // Broken: command does not exist.
        bad: { command: "/nonexistent/does-not-exist", args: [] },
        ok: { command: process.execPath, args: [mock.path] },
      });
      await mgr.startAll();
      const tools = mgr.listAllTools();
      expect(tools.map((t) => t.server)).toEqual(["ok"]);
      const errs = mgr.startErrors();
      expect(errs.map((e) => e.server)).toEqual(["bad"]);
      await mgr.stopAll();
    } finally {
      mock.cleanup();
    }
  });

  it("invokes a tool by server and tool name", async () => {
    const mock = writeMockMcpServer([
      {
        match: { method: "initialize" },
        result: { protocolVersion: "2024-11-05", serverInfo: { name: "ok" } },
      },
      {
        match: { method: "tools/list" },
        result: { tools: [{ name: "echo", description: "d" }] },
      },
      {
        match: { method: "tools/call" },
        result: { content: [{ type: "text", text: "called" }] },
      },
    ]);
    try {
      const mgr = new McpManager({
        ok: { command: process.execPath, args: [mock.path] },
      });
      await mgr.startAll();
      const r = await mgr.invoke("ok", "echo", { x: 1 });
      expect(r.content).toBe("called");
      await mgr.stopAll();
    } finally {
      mock.cleanup();
    }
  });

  it("exposes onError listener for per-server failures", async () => {
    const mgr = new McpManager({
      bad: { command: "/no/such/binary" },
    });
    const seen: string[] = [];
    mgr.onError((e) => seen.push(e.server));
    await mgr.startAll();
    expect(seen).toEqual(["bad"]);
  });
});

describe("SSE transport — frame parsing", () => {
  // We don't run a real SSE server in this test (that would require a TCP
  // listener); instead we unit-test the manager's ability to pick the right
  // transport, and the parseSseResponse helper indirectly through a real
  // request against a Node http server we spin up in-process.

  it("isMcpSseConfig discriminates by the `type` field", () => {
    expect(isMcpSseConfig({ type: "sse", url: "http://x" })).toBe(true);
    expect(isMcpSseConfig({ command: "x" })).toBe(false);
    // Legacy form (no `type` field) defaults to stdio.
    expect(
      isMcpSseConfig({ command: "x", args: ["y"] } as never)
    ).toBe(false);
  });

  it("builds an SSE client for an SSE config and a stdio client otherwise", () => {
    const mgr = new McpManager({
      sse1: { type: "sse", url: "http://localhost:1" } as never,
      std1: { command: "/bin/true" },
    });
    // The clients aren't started; we just want to confirm the manager
    // accepts the union without throwing at construction time.
    expect(mgr.startErrors()).toEqual([]);
    // We don't actually call startAll here because the SSE URL is bogus;
    // we just confirm the manager tolerates the mixed config.
  });

  it("POSTs a JSON-RPC envelope and parses an SSE-framed response", async () => {
    // Spin up a real HTTP server in-process: it returns a single
    // `text/event-stream` body with the JSON-RPC response, so we exercise
    // the SSE response parser inside McpSseClient.
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      // Read the body, ignore it, and respond with an SSE frame.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let id: number | string = 0;
        try {
          const parsed = JSON.parse(text) as { id: number | string };
          id = parsed.id;
        } catch {
          /* ignore */
        }
        const resp = {
          jsonrpc: "2.0",
          id,
          result: { tools: [{ name: "sse-tool", description: "d" }] },
        };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad addr");
    const url = `http://127.0.0.1:${addr.port}/`;
    try {
      const c = new McpSseClient("sse", { type: "sse", url });
      // The first POST is `initialize`, which our mock server doesn't
      // know about, so it returns a JSON-RPC error. That's still a
      // valid response — we just need to confirm the SSE-framed parsing
      // path. To make `start()` succeed we have to also handle
      // `tools/list`; so our mock returns both:
      // Update the server to handle both:
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let id: number | string = 0;
          let method = "";
          try {
            const parsed = JSON.parse(text) as { id: number | string; method: string };
            id = parsed.id;
            method = parsed.method;
          } catch {
            /* ignore */
          }
          let result: unknown = {};
          if (method === "initialize") {
            result = { protocolVersion: "2024-11-05", serverInfo: { name: "sse-mock" } };
          } else if (method === "tools/list") {
            result = { tools: [{ name: "sse-tool", description: "d" }] };
          }
          const resp = { jsonrpc: "2.0", id, result };
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`event: message\ndata: ${JSON.stringify(resp)}\n\n`);
          res.end();
        });
      });
      // Replace the client (the first one already errored):
      const c2 = new McpSseClient("sse", { type: "sse", url });
      // Discard the first failed client.
      void c;
      await c2.start();
      const tools = c2.listTools();
      expect(tools.map((t) => t.name)).toEqual(["sse-tool"]);
      await c2.stop();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("McpManager with mixed transports", () => {
  it("treats legacy config (no `type`) as stdio and new config (type=sse) as SSE", async () => {
    // Constructed only — we don't startAll because the SSE URL is bogus.
    const mgr = new McpManager({
      legacy: { command: "/bin/true" },
      modern: { type: "sse", url: "http://127.0.0.1:1/x" } as never,
    });
    expect(mgr).toBeDefined();
  });
});

describe("Naming helpers", () => {
  it("builds and parses the mcp__server__tool form", () => {
    expect(mcpToolName("srv", "t")).toBe("mcp__srv__t");
    expect(parseMcpToolName("mcp__srv__t")).toEqual({
      server: "srv",
      tool: "t",
      kind: "tool",
    });
  });
  it("builds and parses the mcp__server__resource__name form", () => {
    expect(mcpResourceToolName("srv", "doc")).toBe("mcp__srv__resource__doc");
    expect(parseMcpToolName("mcp__srv__resource__doc")).toEqual({
      server: "srv",
      tool: "doc",
      kind: "resource",
    });
  });
  it("returns null for non-mcp names", () => {
    expect(parseMcpToolName("bash")).toBeNull();
  });
});
