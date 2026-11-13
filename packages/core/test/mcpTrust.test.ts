// Trust-on-first-use for PROJECT-sourced MCP servers. A server defined in a
// project file (`<cwd>/.codepilot/config.json` or `<cwd>/.mcp.json`) can ship an
// arbitrary command, so it must be approved before it launches. User-level /
// managed servers are the user's own and skip the gate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import {
  startMcp,
  projectSourcedMcpServerNames,
  type SessionMcpHost,
} from "../src/session-mcp.js";
import { McpTrustStore, mcpServerConfigHash } from "../src/mcpTrust.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { CodepilotConfig } from "../src/types.js";

describe("McpTrustStore", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-trust-"));
    file = join(dir, "mcp-trust.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a server with no recorded hash is untrusted (TOFU default)", async () => {
    const s = new McpTrustStore(file);
    await s.load();
    expect(s.isTrusted("srv", mcpServerConfigHash({ command: "x" }))).toBe(false);
  });

  it("approve records the hash and persists across instances", async () => {
    const hash = mcpServerConfigHash({ command: "x", args: ["--go"] });
    const s = new McpTrustStore(file);
    await s.approve("srv", hash);
    const fresh = new McpTrustStore(file);
    await fresh.load();
    expect(fresh.isTrusted("srv", hash)).toBe(true);
  });

  it("a config change (new hash) is no longer trusted until re-approved", async () => {
    const s = new McpTrustStore(file);
    await s.approve("srv", mcpServerConfigHash({ command: "old" }));
    expect(s.isTrusted("srv", mcpServerConfigHash({ command: "new" }))).toBe(false);
  });

  it("toggling only `disabled` does not change the hash (no re-approval)", () => {
    const a = mcpServerConfigHash({ command: "x", disabled: false });
    const b = mcpServerConfigHash({ command: "x", disabled: true });
    expect(a).toBe(b);
  });

  it("a missing/corrupt store loads as empty (never fail-open)", async () => {
    writeFileSync(file, "}{ not json", "utf-8");
    const s = new McpTrustStore(file);
    await s.load();
    expect(s.isTrusted("srv", mcpServerConfigHash({ command: "x" }))).toBe(false);
  });

  it("revoke drops a previously approved hash", async () => {
    const hash = mcpServerConfigHash({ command: "x" });
    const s = new McpTrustStore(file);
    await s.approve("srv", hash);
    expect(s.isTrusted("srv", hash)).toBe(true);
    await s.revoke("srv");
    expect(s.isTrusted("srv", hash)).toBe(false);
  });
});

describe("projectSourcedMcpServerNames", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-proj-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("collects names from .codepilot/config.json and .mcp.json", () => {
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({ mcpServers: { repoSrv: { command: "x" } } }),
    );
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { dotSrv: { command: "y" } } }),
    );
    expect([...projectSourcedMcpServerNames(dir)].sort()).toEqual(["dotSrv", "repoSrv"]);
  });

  it("returns empty when no project files exist", () => {
    expect(projectSourcedMcpServerNames(dir).size).toBe(0);
  });

  it("a malformed project file contributes no names (gate stays closed)", () => {
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
    writeFileSync(join(dir, ".codepilot", "config.json"), "}{ broken");
    expect(projectSourcedMcpServerNames(dir).size).toBe(0);
  });
});

describe("startMcp — project-sourced TOFU gate", () => {
  let dir: string;
  let trustFile: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-gate-"));
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
    trustFile = join(dir, "mcp-trust.json");
    acquireMock.mockClear();
    warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function host(config: CodepilotConfig): SessionMcpHost {
    const registry = new ToolRegistry();
    return {
      config,
      cwd: dir,
      mcpTrustFile: trustFile,
      withToolRegistry: (fn: (r: ToolRegistry) => unknown) => fn(registry),
    } as SessionMcpHost;
  }

  function startedServers(): string[] {
    const call = acquireMock.mock.calls[0];
    if (!call) return [];
    return Object.keys(call[0] as Record<string, unknown>);
  }

  it("refuses an unapproved project-sourced server", async () => {
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({ mcpServers: { repoSrv: { command: "x" } } }),
    );
    const mcp = await startMcp(host({ mcpServers: { repoSrv: { command: "x" } } }));
    expect(mcp).toBeNull();
    expect(acquireMock).not.toHaveBeenCalled();
    const notes = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(notes).toMatch(/defined in a project file and has not been approved/);
  });

  it("starts a project-sourced server once its current hash is approved", async () => {
    const cfg = { command: "x", args: ["--go"] };
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({ mcpServers: { repoSrv: cfg } }),
    );
    const trust = new McpTrustStore(trustFile);
    await trust.approve("repoSrv", mcpServerConfigHash(cfg));
    await startMcp(host({ mcpServers: { repoSrv: cfg } }));
    expect(startedServers()).toEqual(["repoSrv"]);
  });

  it("does NOT gate a user-level server (not present in any project file)", async () => {
    // No project file lists `userSrv`, so it is treated as the user's own.
    await startMcp(host({ mcpServers: { userSrv: { command: "x" } } }));
    expect(startedServers()).toEqual(["userSrv"]);
    const notes = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(notes).not.toMatch(/project file/);
  });

  it("re-refuses a project server after its command changes (hash mismatch)", async () => {
    const oldCfg = { command: "old" };
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({ mcpServers: { repoSrv: oldCfg } }),
    );
    const trust = new McpTrustStore(trustFile);
    await trust.approve("repoSrv", mcpServerConfigHash(oldCfg));
    // The effective config now ships a different command → not trusted.
    const mcp = await startMcp(host({ mcpServers: { repoSrv: { command: "new" } } }));
    expect(mcp).toBeNull();
    expect(acquireMock).not.toHaveBeenCalled();
  });
});
