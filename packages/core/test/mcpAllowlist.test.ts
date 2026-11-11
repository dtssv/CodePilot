// Managed MCP server allowlist: config.mcpAllowedServers pins which MCP servers
// may start. Empty/omitted = no restriction; a server not on a non-empty list
// is refused start (and a note is logged). We mock the shared-pool acquire to
// capture exactly which servers reached startup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { acquireMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(async (servers: Record<string, unknown>) => ({
    __servers: servers,
    listAllTools: () => [],
    setServerRequestHandler: () => () => {},
    setToolsChangedHandler: () => () => {},
  })),
}));

vi.mock("../src/mcp-pool.js", () => ({
  acquireSharedMcp: acquireMock,
  releaseSharedMcp: async () => {},
}));

import { startMcp, type SessionMcpHost } from "../src/session-mcp.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { CodepilotConfig } from "../src/types.js";

function host(config: CodepilotConfig): SessionMcpHost {
  const registry = new ToolRegistry();
  return {
    config,
    cwd: "/w",
    withToolRegistry: (fn) => fn(registry),
  } as SessionMcpHost;
}

const stdio = (command: string) => ({ command });

describe("MCP server allowlist", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    acquireMock.mockClear();
    warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  /** The server names startMcp actually passed to the pool. */
  function startedServers(): string[] {
    const call = acquireMock.mock.calls[0];
    if (!call) return [];
    return Object.keys(call[0] as Record<string, unknown>);
  }

  it("empty/omitted allowlist = no restriction (every non-disabled server starts)", async () => {
    await startMcp(
      host({ mcpServers: { a: stdio("a"), b: stdio("b") } }),
    );
    expect(startedServers().sort()).toEqual(["a", "b"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a non-empty allowlist only starts listed servers and refuses the rest", async () => {
    await startMcp(
      host({
        mcpServers: { a: stdio("a"), b: stdio("b"), c: stdio("c") },
        mcpAllowedServers: ["a", "c"],
      }),
    );
    expect(startedServers().sort()).toEqual(["a", "c"]);
    // A note was logged for the refused server.
    const notes = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(notes).toMatch(/MCP server "b" is not in mcpAllowedServers/);
  });

  it("returns null when the allowlist excludes every configured server", async () => {
    const mcp = await startMcp(
      host({
        mcpServers: { a: stdio("a") },
        mcpAllowedServers: ["other"],
      }),
    );
    expect(mcp).toBeNull();
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("still honours per-server disabled alongside the allowlist", async () => {
    await startMcp(
      host({
        mcpServers: { a: stdio("a"), b: { ...stdio("b"), disabled: true } },
        mcpAllowedServers: ["a", "b"],
      }),
    );
    // b is allowlisted but disabled → not started (and no allowlist note).
    expect(startedServers()).toEqual(["a"]);
    const notes = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(notes).not.toMatch(/mcpAllowedServers/);
  });
});
