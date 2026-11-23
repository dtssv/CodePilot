import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeMcpMetaTool } from "../src/tools/mcp_tool.js";
import { ToolRegistry, type ToolContext } from "../src/tools/types.js";
import {
  expandMcpPromptCommand,
  formatPromptResult,
  formatResourceReadResult,
  listMcpPromptSlashCommands,
  mcpPromptToSlashCommand,
} from "../src/mcp/mcpPromptCommands.js";
import {
  mcpPromptCommandName,
  mcpPromptCommandNamePrefixed,
  parseMcpPromptCommandName,
} from "../src/mcp/mcp-names.js";
import type { McpManager } from "../src/mcp/mcp.js";
import { DIRECT_WIRE_TOOLS } from "../src/tools/wirePolicy.js";

function fakeMgr(opts: {
  prompts?: Array<{
    server: string;
    name: string;
    description?: string;
    arguments?: Array<{ name: string; required?: boolean }>;
  }>;
  resources?: Array<{ server: string; uri: string; name: string; description?: string }>;
  getPrompt?: (server: string, name: string, args?: Record<string, string>) => Promise<unknown>;
  readResource?: (server: string, uri: string) => Promise<{ contents: Array<{ text?: string }> }>;
}): McpManager {
  return {
    listAllPrompts: () => opts.prompts ?? [],
    listAllResources: () => opts.resources ?? [],
    getPrompt: opts.getPrompt ?? (async () => ({ messages: [] })),
    readResource: opts.readResource ?? (async () => ({ contents: [] })),
  } as unknown as McpManager;
}

const ctx = { cwd: "/" } as ToolContext;

describe("mcp prompt slash naming", () => {
  it("uses mcp__server__prompt and parses both forms", () => {
    expect(mcpPromptCommandName("srv", "greet")).toBe("mcp__srv__greet");
    expect(mcpPromptCommandNamePrefixed("srv", "greet")).toBe("mcp__srv__prompt__greet");
    expect(parseMcpPromptCommandName("mcp__srv__greet")).toEqual({
      server: "srv",
      prompt: "greet",
    });
    expect(parseMcpPromptCommandName("mcp__srv__prompt__greet")).toEqual({
      server: "srv",
      prompt: "greet",
    });
  });

  it("lists prompts as slash commands and prefixes on collision", () => {
    const mgr = fakeMgr({
      prompts: [{ server: "docs", name: "search", description: "Search docs" }],
    });
    const plain = listMcpPromptSlashCommands(mgr);
    expect(plain).toHaveLength(1);
    expect(plain[0]!.name).toBe("mcp__docs__search");
    expect(plain[0]!.source).toBe("mcp");
    expect(plain[0]!.mcpPrompt).toEqual({ server: "docs", name: "search" });

    const warnings: string[] = [];
    const collided = listMcpPromptSlashCommands(mgr, {
      takenNames: new Set(["mcp__docs__search"]),
      onWarn: (m) => warnings.push(m),
    });
    expect(collided[0]!.name).toBe("mcp__docs__prompt__search");
    expect(warnings[0]).toMatch(/collides/);
  });

  it("expands getPrompt into sanitized user text", async () => {
    const mgr = fakeMgr({
      getPrompt: async (_s, name, args) => ({
        description: `prompt ${name}`,
        messages: [{ role: "user", content: [{ type: "text", text: `hi ${args?.q ?? ""}` }] }],
      }),
    });
    const cmd = mcpPromptToSlashCommand({ server: "docs", name: "search" });
    const text = await expandMcpPromptCommand(cmd, "q=world", mgr);
    expect(text).toContain("prompt search");
    expect(text).toContain("[user]");
    expect(text).toContain("hi world");
  });

  it("formatPromptResult / formatResourceReadResult cover empty + text", () => {
    expect(formatPromptResult(null)).toBe("");
    expect(formatPromptResult({ messages: [{ role: "assistant", content: "ok" }] })).toContain(
      "[assistant]",
    );
    expect(formatResourceReadResult({ contents: [] })).toBe("(empty resource)");
    expect(
      formatResourceReadResult({
        contents: [{ uri: "u", text: "body" }],
      }),
    ).toContain("body");
  });
});

describe("mcp meta prompts/resources", () => {
  it("lists and gets prompts via meta actions", async () => {
    const reg = new ToolRegistry();
    const getPrompt = vi.fn(async () => ({
      messages: [{ role: "user", content: "expanded" }],
    }));
    const mgr = fakeMgr({
      prompts: [
        {
          server: "docs",
          name: "intro",
          description: "Intro prompt",
          arguments: [{ name: "topic", required: true }],
        },
      ],
      getPrompt,
    });
    const meta = makeMcpMetaTool(() => reg, () => mgr);

    const listed = await meta.execute({ action: "list_prompts" } as never, ctx);
    expect(listed.content).toContain("docs/intro");
    expect(listed.content).toContain("topic");

    const got = await meta.execute(
      { action: "get_prompt", server: "docs", name: "intro", args: { topic: "x" } } as never,
      ctx,
    );
    expect(got.isError).toBeFalsy();
    expect(got.content).toContain("expanded");
    expect(getPrompt).toHaveBeenCalledWith("docs", "intro", { topic: "x" });
  });

  it("lists and reads resources via meta actions", async () => {
    const reg = new ToolRegistry();
    const readResource = vi.fn(async () => ({
      contents: [{ uri: "file://a", text: "resource body" }],
    }));
    const mgr = fakeMgr({
      resources: [
        { server: "docs", uri: "file://a", name: "a", description: "A file" },
      ],
      readResource,
    });
    const meta = makeMcpMetaTool(() => reg, () => mgr);

    const listed = await meta.execute({ action: "list_resources" } as never, ctx);
    expect(listed.content).toContain("file://a");

    const read = await meta.execute(
      { action: "read_resource", server: "docs", uri: "file://a" } as never,
      ctx,
    );
    expect(read.content).toContain("resource body");
    expect(readResource).toHaveBeenCalledWith("docs", "file://a");
  });

  it("errors clearly when manager missing or params incomplete", async () => {
    const reg = new ToolRegistry();
    const meta = makeMcpMetaTool(() => reg, () => null);
    const noMgr = await meta.execute({ action: "list_prompts" } as never, ctx);
    expect(noMgr.content).toMatch(/No MCP servers/);

    const withMgr = makeMcpMetaTool(() => reg, () => fakeMgr({}));
    const missing = await withMgr.execute({ action: "get_prompt", name: "x" } as never, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/requires `server` and `name`/);

    const missingUri = await withMgr.execute(
      { action: "read_resource", server: "s" } as never,
      ctx,
    );
    expect(missingUri.isError).toBe(true);
  });

  it("keeps tool list/call working and mcp is on the direct wire", async () => {
    expect(DIRECT_WIRE_TOOLS.has("mcp")).toBe(true);
    const reg = new ToolRegistry();
    reg.register({
      name: "mcp__srv__echo",
      description: "[mcp:srv] echo",
      inputSchema: z.object({ q: z.string().optional() }),
      permission: "network",
      source: "mcp",
      mcpMeta: { server: "srv", toolName: "echo", jsonSchema: { type: "object" } },
      async execute(input) {
        return { content: `echo:${(input as { q?: string }).q ?? ""}` };
      },
    });
    const meta = makeMcpMetaTool(() => reg, () => fakeMgr({}));
    const list = await meta.execute({ action: "list" } as never, ctx);
    expect(list.content).toContain("mcp__srv__echo");
    const call = await meta.execute(
      { action: "call", name: "mcp__srv__echo", args: { q: "hi" } } as never,
      ctx,
    );
    expect(call.content).toBe("echo:hi");
  });
});
