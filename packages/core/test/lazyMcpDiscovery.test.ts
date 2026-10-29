import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildProviderToolDefs } from "../src/agent-messages.js";
import { makeMcpMetaTool } from "../src/tools/mcp_tool.js";
import { ToolRegistry, type ToolDef } from "../src/tools/types.js";

function builtin(name: string): ToolDef {
  return {
    name,
    description: `builtin ${name}`,
    inputSchema: z.object({}),
    permission: "read",
    async execute() {
      return { content: "ok" };
    },
  };
}

function mcpTool(name: string, server = "feishu"): ToolDef {
  let called: Record<string, unknown> | null = null;
  const tool: ToolDef & { lastArgs?: () => Record<string, unknown> | null } = {
    name,
    description: `[mcp:${server}] does ${name}`,
    inputSchema: z.object({ q: z.string().optional() }),
    permission: "network",
    source: "mcp",
    mcpMeta: { server, toolName: name.replace(`mcp__${server}__`, ""), jsonSchema: { type: "object" } },
    async execute(input) {
      called = input as Record<string, unknown>;
      return { content: `invoked ${name}` };
    },
    lastArgs: () => called,
  };
  return tool;
}

describe("lazy MCP tool discovery", () => {
  it("hides individual MCP tools from the provider list when lazy", () => {
    const reg = new ToolRegistry();
    reg.register(builtin("bash"));
    reg.register(mcpTool("mcp__feishu__a"));
    reg.register(mcpTool("mcp__feishu__b"));

    const eager = buildProviderToolDefs(reg, "agent", { lazyMcp: false }).map((t) => t.name);
    expect(eager).toContain("mcp__feishu__a");
    expect(eager).toContain("mcp__feishu__b");

    const lazy = buildProviderToolDefs(reg, "agent", { lazyMcp: true }).map((t) => t.name);
    expect(lazy).toContain("bash");
    expect(lazy).not.toContain("mcp__feishu__a");
    expect(lazy).not.toContain("mcp__feishu__b");
  });

  it("mcp meta-tool lists, describes, and calls MCP tools", async () => {
    const reg = new ToolRegistry();
    const a = mcpTool("mcp__feishu__search");
    reg.register(builtin("bash"));
    reg.register(a);
    const meta = makeMcpMetaTool(() => reg);

    const list = await meta.execute({ action: "list" } as never, { cwd: "/" } as never);
    expect(list.content).toContain("mcp__feishu__search");
    expect(list.content).not.toContain("bash"); // only MCP tools listed

    const desc = await meta.execute({ action: "describe", name: "mcp__feishu__search" } as never, { cwd: "/" } as never);
    expect(desc.content).toContain("Input schema");

    const call = await meta.execute(
      { action: "call", name: "mcp__feishu__search", args: { q: "hi" } } as never,
      { cwd: "/" } as never,
    );
    expect(call.content).toContain("invoked mcp__feishu__search");
  });

  it("mcp meta-tool errors clearly on unknown tool / missing name", async () => {
    const reg = new ToolRegistry();
    reg.register(mcpTool("mcp__feishu__x"));
    const meta = makeMcpMetaTool(() => reg);

    const noName = await meta.execute({ action: "describe" } as never, { cwd: "/" } as never);
    expect(noName.isError).toBe(true);

    const unknown = await meta.execute({ action: "call", name: "nope" } as never, { cwd: "/" } as never);
    expect(unknown.isError).toBe(true);
  });

  it("mcp list filters by query and ranks name matches first", async () => {
    const reg = new ToolRegistry();
    reg.register(mcpTool("mcp__feishu__message_create")); // name contains "message"
    reg.register(mcpTool("mcp__feishu__chat_list"));
    reg.register(mcpTool("mcp__feishu__bitable_record")); // desc mentions nothing matching
    const meta = makeMcpMetaTool(() => reg);

    const all = await meta.execute({ action: "list" } as never, { cwd: "/" } as never);
    expect(all.content).toContain("Available MCP tools (3)");

    const filtered = await meta.execute({ action: "list", query: "message" } as never, { cwd: "/" } as never);
    expect(filtered.content).toContain("mcp__feishu__message_create");
    expect(filtered.content).not.toContain("mcp__feishu__chat_list");
    expect(filtered.content).toContain('matching "message"');

    const none = await meta.execute({ action: "list", query: "zzzznomatch" } as never, { cwd: "/" } as never);
    expect(none.content).toContain("No MCP tools match");
  });

  it("mcp list truncates to a char budget with an overflow hint", async () => {
    const reg = new ToolRegistry();
    // 200 tools with long descriptions → well over the 4000-char budget.
    for (let i = 0; i < 200; i++) {
      const t = mcpTool(`mcp__feishu__tool_${i}`);
      t.description = `[mcp:feishu] ${"x".repeat(80)} tool number ${i}`;
      reg.register(t);
    }
    const meta = makeMcpMetaTool(() => reg);
    const list = await meta.execute({ action: "list" } as never, { cwd: "/" } as never);
    expect(list.content.length).toBeLessThan(5000); // bounded, not all 200
    expect(list.content).toContain("more — narrow with");
  });

  it("mcp batch invokes multiple tools in parallel in one step", async () => {
    const reg = new ToolRegistry();
    reg.register(mcpTool("mcp__feishu__a"));
    reg.register(mcpTool("mcp__feishu__b"));
    const meta = makeMcpMetaTool(() => reg);

    const r = await meta.execute(
      {
        action: "batch",
        calls: [
          { name: "mcp__feishu__a", args: { q: "1" } },
          { name: "mcp__feishu__b", args: { q: "2" } },
          { name: "mcp__feishu__missing" },
        ],
      } as never,
      { cwd: "/" } as never,
    );
    expect(r.content).toContain("invoked mcp__feishu__a");
    expect(r.content).toContain("invoked mcp__feishu__b");
    expect(r.content).toContain("unknown MCP tool: mcp__feishu__missing");
    expect(r.isError).toBe(true); // one call failed
  });
});
