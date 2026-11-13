// MCP tool annotations → permission tier. A server's self-reported hints map a
// read-only tool to the "read" tier and carry `destructiveHint` into mcpMeta so
// the permission engine can require confirmation. Hints are untrusted: they
// only relax a no-op case or make a destructive tool stricter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolDescriptor } from "../src/mcp-types.js";

const tools: McpToolDescriptor[] = [
  {
    server: "s",
    name: "read_thing",
    description: "reads",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    server: "s",
    name: "wipe_thing",
    description: "destroys",
    inputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
  {
    server: "s",
    name: "mutate_thing",
    description: "writes, non-destructive",
    inputSchema: { type: "object" },
  },
  {
    server: "s",
    name: "read_but_destructive",
    description: "read-only wins over destructive",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: true },
  },
];

const { acquireMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(),
}));

vi.mock("../src/mcp-pool.js", () => ({
  acquireSharedMcp: acquireMock,
  releaseSharedMcp: async () => {},
}));

import { startMcp, type SessionMcpHost } from "../src/session-mcp.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { CodepilotConfig } from "../src/types.js";

describe("MCP tool annotations → permission tier", () => {
  let registry: ToolRegistry;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registry = new ToolRegistry();
    acquireMock.mockReset();
    acquireMock.mockResolvedValue({
      listAllTools: () => tools,
      setServerRequestHandler: () => () => {},
      setToolsChangedHandler: () => () => {},
    });
    warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => warn.mockRestore());

  async function start(): Promise<void> {
    const config = { mcpServers: { s: { command: "s" } } } as CodepilotConfig;
    const host = {
      config,
      cwd: "/w",
      withToolRegistry: <T,>(fn: (r: ToolRegistry) => T) => fn(registry),
    } as SessionMcpHost;
    await startMcp(host);
  }

  function find(originalName: string) {
    return registry
      .all()
      .find((t) => t.source === "mcp" && t.mcpMeta?.toolName === originalName);
  }

  it("maps a read-only tool to the read tier", async () => {
    await start();
    const t = find("read_thing");
    expect(t?.permission).toBe("read");
    expect(t?.mcpMeta?.destructiveHint).toBeUndefined();
  });

  it("keeps a destructive tool on the network tier but flags it", async () => {
    await start();
    const t = find("wipe_thing");
    expect(t?.permission).toBe("network");
    expect(t?.mcpMeta?.destructiveHint).toBe(true);
  });

  it("leaves a plain (unhinted) tool on the network tier with no flag", async () => {
    await start();
    const t = find("mutate_thing");
    expect(t?.permission).toBe("network");
    expect(t?.mcpMeta?.destructiveHint).toBeUndefined();
  });

  it("read-only wins over destructive (not flagged, read tier)", async () => {
    await start();
    const t = find("read_but_destructive");
    expect(t?.permission).toBe("read");
    expect(t?.mcpMeta?.destructiveHint).toBeUndefined();
  });
});
