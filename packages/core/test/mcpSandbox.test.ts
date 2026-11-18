import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpStdioClient, mcpSpawnSpec, mcpWantsSandbox } from "../src/mcp/mcp-stdio.js";
import { detectSandboxBackend } from "../src/sandbox/sandbox.js";

/** A stdio MCP server that tries two writes at startup and reports the
 * outcome as its tool names (`inside_ok`, `outside_denied`, …). */
function probeServer(dir: string, inside: string, outside: string): string {
  const path = join(dir, "probe.mjs");
  writeFileSync(
    path,
    `
import fs from 'node:fs';
import readline from 'node:readline';
const probe = (p) => { try { fs.writeFileSync(p, 'x'); return 'ok'; } catch { return 'denied'; } };
const names = ['inside_' + probe(${JSON.stringify(inside)}), 'outside_' + probe(${JSON.stringify(outside)})];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === 'initialize'
    ? { protocolVersion: '2024-11-05', serverInfo: { name: 'probe', version: '0' }, capabilities: { tools: {} } }
    : msg.method === 'tools/list'
      ? { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`,
    "utf-8",
  );
  return path;
}

const backend = detectSandboxBackend();
const canSandbox = process.platform !== "win32" && backend !== "none";

describe("MCP stdio sandbox", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function setup() {
    const cwd = mkdtempSync(join(tmpdir(), "cp-mcp-sb-"));
    // The real home: the test harness points HOME into tmp, which is writable.
    const outside = join(userInfo().homedir, `.cp-mcp-sandbox-probe-${randomUUID()}`);
    cleanups.push(() => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { force: true });
    });
    const script = probeServer(cwd, join(cwd, "inside.txt"), outside);
    return { cwd, outside, script };
  }

  it("is opt-in: per server or for all servers via mcpSandbox", () => {
    const cfg = { command: "node", args: ["x.js"] };
    const ctx = { cwd: "/w", openAuthUrl: null, sandbox: {} };
    expect(mcpWantsSandbox(cfg, ctx)).toBe(false);
    expect(mcpWantsSandbox({ ...cfg, sandbox: true }, ctx)).toBe(true);
    expect(mcpWantsSandbox({ ...cfg, sandbox: { writablePaths: ["/x"] } }, ctx)).toBe(true);
    expect(mcpWantsSandbox(cfg, { ...ctx, mcpSandbox: true })).toBe(true);
    expect(mcpWantsSandbox({ ...cfg, sandbox: false }, { ...ctx, mcpSandbox: true })).toBe(false);
    expect(mcpWantsSandbox({ ...cfg, sandbox: true }, { ...ctx, sandbox: { mode: "off" } })).toBe(false);
    expect(mcpWantsSandbox({ ...cfg, sandbox: true })).toBe(false);
    expect(mcpSpawnSpec(cfg, ctx).sandbox).toBeNull();
  });

  it.skipIf(!canSandbox)("expands ~ in a server's extra writable paths", () => {
    const ctx = { cwd: tmpdir(), openAuthUrl: null, sandbox: {} };
    const expanded = mcpSpawnSpec(
      { command: "node", args: [], sandbox: { writablePaths: ["~/cp-notes"] } },
      ctx,
    );
    const literal = mcpSpawnSpec(
      { command: "node", args: [], sandbox: { writablePaths: [join(homedir(), "cp-notes")] } },
      ctx,
    );
    // `~` must resolve to the home directory rather than reach the backend as-is.
    expect(expanded.sandbox).not.toBeNull();
    expect(expanded.args).toEqual(literal.args);
    expect(expanded.args.join(" ")).not.toContain("~/cp-notes");
  });

  it.skipIf(!canSandbox)("confines a server's writes to the workspace (real backend)", async () => {
    const { cwd, outside, script } = setup();
    const c = new McpStdioClient("probe", { command: process.execPath, args: [script], sandbox: true }, { cwd, openAuthUrl: null, sandbox: {} });
    cleanups.push(() => void c.close?.());
    await c.start();
    expect(c.listTools().map((t) => t.name).sort()).toEqual(["inside_ok", "outside_denied"]);
    expect(existsSync(outside)).toBe(false);
  }, 30_000);

  it.skipIf(!canSandbox)("a server that did not opt in runs unconfined", async () => {
    const { cwd, outside, script } = setup();
    const c = new McpStdioClient(
      "probe",
      { command: process.execPath, args: [script] },
      { cwd, openAuthUrl: null, sandbox: {} },
    );
    cleanups.push(() => void c.close?.());
    await c.start();
    expect(c.listTools().map((t) => t.name).sort()).toEqual(["inside_ok", "outside_ok"]);
  }, 30_000);
});
