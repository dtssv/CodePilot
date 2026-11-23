import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
  buildProviderToolDefs,
  listAdvertisedToolNames,
  rememberAdvertisedToolNames,
  sortToolsForCache,
} from "../src/agent/agent-messages.js";
import { runOneTool } from "../src/agent/agent-tools.js";
import type { AgentDeps } from "../src/agent/agent-types.js";
import {
  clearProviderToolDefMemo,
  compactToolSchema,
  toProviderToolDef,
  DEFAULT_COMPACT_TOOL_SCHEMA_BYTES,
} from "../src/tools/schemaCache.js";
import { ToolRegistry, type ToolDef } from "../src/tools/types.js";

function builtin(name: string): ToolDef {
  return {
    name,
    description: `builtin ${name}`,
    inputSchema: z.object({}),
    permission: name === "bash" ? "execute" : "read",
    source: "builtin",
    async execute() {
      return { content: "ok" };
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
    async execute() {
      return { content: "ok" };
    },
  };
}

function pluginTool(name: string): ToolDef {
  return {
    name,
    description: `plugin ${name}`,
    inputSchema: z.object({}),
    permission: "execute",
    source: "plugin",
    async execute() {
      return { content: "ok" };
    },
  };
}

beforeEach(() => {
  clearProviderToolDefMemo();
});

describe("tool table stability", () => {
  it("agent → chat: wire tool names do not shrink; execute still denies bash", async () => {
    const reg = new ToolRegistry();
    for (const n of ["bash", "read_file", "grep"]) reg.register(builtin(n));

    const advertised = new Set<string>();
    const agentNames = listAdvertisedToolNames(reg, "agent", {
      previouslyAdvertised: advertised,
    });
    rememberAdvertisedToolNames(advertised, agentNames);
    expect(agentNames).toContain("bash");

    const chatNames = listAdvertisedToolNames(reg, "chat", {
      previouslyAdvertised: advertised,
    });
    rememberAdvertisedToolNames(advertised, chatNames);
    expect(chatNames).toContain("bash");
    expect(new Set(chatNames)).toEqual(new Set(agentNames));

    // Cold start in chat still starts small (no previouslyAdvertised).
    const coldChat = listAdvertisedToolNames(reg, "chat", {});
    expect(coldChat).not.toContain("bash");
    expect(coldChat).toContain("read_file");

    const denied = await runOneTool(
      { type: "tool_use", id: "t1", name: "bash", input: { command: "true" } },
      { tools: reg } as AgentDeps,
      async () => {},
      "chat",
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toMatch(/not allowed in chat mode/);
  });

  it("sorts builtin → plugin → mcp, names sorted within group", () => {
    const tools = [
      mcpTool("mcp__z"),
      pluginTool("plugin_b"),
      builtin("zeta"),
      mcpTool("mcp__a"),
      pluginTool("plugin_a"),
      builtin("alpha"),
    ];
    expect(sortToolsForCache(tools).map((t) => t.name)).toEqual([
      "alpha",
      "zeta",
      "plugin_a",
      "plugin_b",
      "mcp__a",
      "mcp__z",
    ]);

    const reg = new ToolRegistry();
    for (const t of tools) reg.register(t);
    expect(listAdvertisedToolNames(reg, "agent")).toEqual([
      "alpha",
      "zeta",
      "plugin_a",
      "plugin_b",
      "mcp__a",
      "mcp__z",
    ]);
  });

  it("memo: two builds share the same inputSchema object identity", () => {
    const reg = new ToolRegistry();
    reg.register(builtin("read_file"));
    const a = buildProviderToolDefs(reg, "agent");
    const b = buildProviderToolDefs(reg, "agent");
    expect(a[0]!.inputSchema).toBe(b[0]!.inputSchema);
    expect(toProviderToolDef(reg.get("read_file")!)).toBe(a[0]);
  });

  it("compaction: oversized nested MCP schema loses nested descriptions / fits budget", () => {
    // Size comes from non-description payload so strip alone cannot fit —
    // later passes ($defs drop, depth collapse) must run.
    const nested: Record<string, unknown> = {
      type: "object",
      description: "top",
      properties: {
        outer: {
          type: "object",
          description: "nested desc",
          properties: {
            mid: {
              type: "object",
              description: "mid desc",
              properties: {
                deep: {
                  type: "object",
                  description: "deep desc",
                  properties: {
                    leaf: {
                      type: "string",
                      description: "leaf",
                      enum: Array.from({ length: 400 }, (_, i) => `v${i}_${"p".repeat(20)}`),
                    },
                  },
                },
              },
            },
          },
        },
      },
      $defs: {
        Blob: {
          type: "object",
          description: "blob",
          properties: {
            data: { type: "string", description: "d".repeat(2000) },
          },
        },
      },
    };

    const before = Buffer.byteLength(JSON.stringify(nested), "utf8");
    expect(before).toBeGreaterThan(DEFAULT_COMPACT_TOOL_SCHEMA_BYTES);

    compactToolSchema(nested, DEFAULT_COMPACT_TOOL_SCHEMA_BYTES);
    const after = Buffer.byteLength(JSON.stringify(nested), "utf8");
    expect(after).toBeLessThanOrEqual(DEFAULT_COMPACT_TOOL_SCHEMA_BYTES);
    expect(JSON.stringify(nested)).not.toMatch(/"description"/);
    expect(nested.$defs).toBeUndefined();

    // Deep object tree (not a giant enum) so the depth-collapse pass can
    // bring the memoised MCP def under budget after description strip.
    const deepProps: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      deepProps[`f${i}`] = {
        type: "object",
        description: `field ${i}`,
        properties: {
          a: {
            type: "object",
            description: "a",
            properties: {
              b: {
                type: "object",
                description: "b",
                properties: {
                  c: { type: "string", description: "c".repeat(80) },
                },
              },
            },
          },
        },
      };
    }
    const reg = new ToolRegistry();
    const fat: ToolDef = {
      name: "mcp__fat",
      description: "fat mcp",
      inputSchema: z.object({}),
      permission: "network",
      source: "mcp",
      mcpMeta: {
        server: "srv",
        toolName: "fat",
        jsonSchema: {
          type: "object",
          description: "fat",
          properties: deepProps,
          $defs: { X: { type: "string", description: "x".repeat(500) } },
        },
      },
      async execute() {
        return { content: "ok" };
      },
    };
    reg.register(fat);
    const def = buildProviderToolDefs(reg, "agent")[0]!;
    expect(Buffer.byteLength(JSON.stringify(def.inputSchema), "utf8")).toBeLessThanOrEqual(
      DEFAULT_COMPACT_TOOL_SCHEMA_BYTES,
    );
    expect(JSON.stringify(def.inputSchema)).not.toMatch(/"description"/);
    expect(def.inputSchema.$defs).toBeUndefined();
  });

  it("lazy MCP flip mid-session does not drop previously advertised MCP tools", () => {
    const reg = new ToolRegistry();
    reg.register(builtin("read_file"));
    reg.register(mcpTool("mcp__feishu__doc"));
    const advertised = new Set<string>();

    const eager = buildProviderToolDefs(reg, "agent", {
      lazyMcp: false,
      previouslyAdvertised: advertised,
    });
    rememberAdvertisedToolNames(
      advertised,
      eager.map((t) => t.name),
    );
    expect(eager.map((t) => t.name)).toContain("mcp__feishu__doc");

    const lazy = buildProviderToolDefs(reg, "agent", {
      lazyMcp: true,
      previouslyAdvertised: advertised,
    });
    expect(lazy.map((t) => t.name)).toContain("mcp__feishu__doc");
  });
});
