import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
  buildProviderToolDefs,
  listAdvertisedToolNames,
  rememberAdvertisedToolNames,
} from "../src/agent/agent-messages.js";
import { makeCodeModeTool } from "../src/tools/code_mode.js";
import {
  DIRECT_WIRE_TOOLS,
  isDirectWireTool,
  resolveDeferredWire,
} from "../src/tools/wirePolicy.js";
import { clearProviderToolDefMemo } from "../src/tools/schemaCache.js";
import { ToolRegistry, type ToolDef, type ToolContext } from "../src/tools/types.js";
import { resolveSandbox } from "../src/sandbox/sandbox.js";
import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function realTmpdir(): string {
  return realpathSync(tmpdir());
}

function builtin(name: string, permission: ToolDef["permission"] = "read"): ToolDef {
  return {
    name,
    description: `builtin ${name}`,
    inputSchema: z.object({}).passthrough(),
    permission,
    async execute() {
      return { content: `ran ${name}` };
    },
  };
}

function mcpTool(name: string): ToolDef {
  return {
    name,
    description: `[mcp:srv] ${name}`,
    inputSchema: z.object({ q: z.string().optional() }),
    permission: "network",
    source: "mcp",
    mcpMeta: {
      server: "srv",
      toolName: name,
      jsonSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    async execute(input) {
      return { content: `mcp:${name}:${JSON.stringify(input ?? {})}` };
    },
  };
}

function makeCtx(cwd: string, extra?: Partial<ToolContext>): ToolContext {
  return {
    cwd,
    signal: undefined,
    sandbox: resolveSandbox(
      { mode: "workspace-write", fallback: "allow-unsandboxed" },
      cwd,
    ),
    async artifact() {
      return "art_x";
    },
    async readArtifact() {
      return "";
    },
    agentMode: "agent",
    ...extra,
  };
}

beforeEach(() => {
  clearProviderToolDefMemo();
});

describe("deferredWire policy", () => {
  it("resolveDeferredWire defaults on when code_mode enabled", () => {
    expect(resolveDeferredWire({})).toBe(true);
    expect(resolveDeferredWire({ codeMode: {} })).toBe(true);
    expect(resolveDeferredWire({ codeMode: { deferredWire: false } })).toBe(false);
    expect(resolveDeferredWire({ codeMode: { enabled: false } })).toBe(false);
  });

  it("with deferredWire, wire is allowlist-only; MCP never sticky", () => {
    const reg = new ToolRegistry();
    for (const n of ["bash", "read_file", "web_fetch", "skill", "code_mode"]) {
      reg.register(builtin(n, n === "bash" ? "execute" : "read"));
    }
    reg.register(mcpTool("mcp__srv__doc"));

    const names = listAdvertisedToolNames(reg, "agent", { deferredWire: true });
    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("code_mode");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("skill");
    expect(names).not.toContain("mcp__srv__doc");
    for (const n of names) expect(DIRECT_WIRE_TOOLS.has(n)).toBe(true);

    const advertised = new Set(["mcp__srv__doc", "web_fetch", "bash"]);
    const after = listAdvertisedToolNames(reg, "agent", {
      deferredWire: true,
      previouslyAdvertised: advertised,
    });
    expect(after).toContain("bash");
    expect(after).not.toContain("mcp__srv__doc");
    expect(after).not.toContain("web_fetch");
  });

  it("deferredWire false keeps full agent table including MCP when not lazy", () => {
    const reg = new ToolRegistry();
    reg.register(builtin("bash", "execute"));
    reg.register(builtin("web_fetch", "network"));
    reg.register(mcpTool("mcp__srv__doc"));
    const names = listAdvertisedToolNames(reg, "agent", {
      deferredWire: false,
      lazyMcp: false,
    });
    expect(names).toContain("web_fetch");
    expect(names).toContain("mcp__srv__doc");
  });

  it("isDirectWireTool rejects mcp/plugin even if name collides", () => {
    expect(isDirectWireTool("bash")).toBe(true);
    expect(
      isDirectWireTool({
        name: "bash",
        description: "x",
        inputSchema: z.object({}),
        permission: "execute",
        source: "mcp",
        async execute() {
          return { content: "no" };
        },
      }),
    ).toBe(false);
  });
});

describe("code_mode deferred tools.*", () => {
  it("tools.search lists MCP; tools.call invokes it", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "dw-"));
    const reg = new ToolRegistry();
    reg.register(mcpTool("mcp__srv__doc"));
    const cm = makeCodeModeTool(() => reg);
    const ctx = makeCtx(dir);

    const search = await cm.execute(
      { code: 'return await tools.search("doc");' },
      ctx,
    );
    expect(search.isError).toBeFalsy();
    expect(search.content).toMatch(/mcp__srv__doc/);

    const call = await cm.execute(
      { code: 'return await tools.call("mcp__srv__doc", { q: "hi" });' },
      ctx,
    );
    expect(call.isError).toBeFalsy();
    expect(call.content).toMatch(/mcp:mcp__srv__doc/);
    expect(call.content).toMatch(/"q":"hi"/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("tools.call refuses mode-forbidden deferred tools", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "dw-"));
    const reg = new ToolRegistry();
    // memory_write is deferred + chat-denied (side-effect).
    reg.register(builtin("memory_write", "write"));
    const cm = makeCodeModeTool(() => reg);
    const ctx = makeCtx(dir, { agentMode: "chat" });

    const r = await cm.execute(
      { code: 'return await tools.call("memory_write", {});' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not allowed in chat mode/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("tools.call uses callDeferredTool when provided (permission path)", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "dw-"));
    const reg = new ToolRegistry();
    reg.register(mcpTool("mcp__srv__doc"));
    const cm = makeCodeModeTool(() => reg);
    let seen = "";
    const ctx = makeCtx(dir, {
      callDeferredTool: async (name, args) => {
        seen = `${name}:${JSON.stringify(args)}`;
        return { content: `via-leaf:${seen}` };
      },
    });

    const r = await cm.execute(
      { code: 'return await tools.call("mcp__srv__doc", { q: "x" });' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe('via-leaf:mcp__srv__doc:{"q":"x"}');
    expect(seen).toContain("mcp__srv__doc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("buildProviderToolDefs under deferredWire omits deferred builtins", () => {
    const reg = new ToolRegistry();
    for (const n of ["bash", "read_file", "code_mode", "web_search", "diagnostics"]) {
      reg.register(builtin(n));
    }
    const defs = buildProviderToolDefs(reg, "agent", { deferredWire: true });
    const names = defs.map((d) => d.name);
    expect(names.sort()).toEqual(["bash", "code_mode", "read_file"].sort());
    rememberAdvertisedToolNames(new Set(), names);
  });
});
