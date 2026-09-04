import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  filterToolsByMode,
  filterToolsByModeFromRegistry,
  filterToolNames,
} from "../src/tools/modes.js";
import {
  ToolRegistry,
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  lsTool,
  planUpdateTool,
  memoryWriteTool,
  readArtifactTool,
  taskTool,
} from "../src/tools/index.js";
import type { ToolDef } from "../src/tools/types.js";

describe("filterToolsByMode", () => {
  it("agent mode returns every tool unchanged (in order)", () => {
    const tools = [
      readFileTool,
      bashTool,
      writeFileTool,
      planUpdateTool,
      memoryWriteTool,
      taskTool,
    ];
    const out = filterToolsByMode(tools, "agent");
    expect(out.map((t) => t.name)).toEqual([
      "read_file",
      "bash",
      "write_file",
      "plan_update",
      "memory_write",
      "task",
    ]);
  });

  it("chat mode keeps only the read-only baseline", () => {
    const tools = [
      readFileTool,
      bashTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
      lsTool,
      planUpdateTool,
      memoryWriteTool,
      readArtifactTool,
      taskTool,
    ];
    const names = filterToolNames(tools, "chat").sort();
    expect(names).toEqual(
      ["glob", "grep", "ls", "read_artifact", "read_file"].sort()
    );
  });

  it("chat mode never includes bash/write_file/edit_file/task/plan_update/memory_write", () => {
    const tools = [bashTool, writeFileTool, editFileTool, taskTool, planUpdateTool, memoryWriteTool];
    expect(filterToolNames(tools, "chat")).toEqual([]);
  });

  it("plan mode keeps read-only + plan_update + memory_write", () => {
    const tools = [
      readFileTool,
      bashTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
      lsTool,
      planUpdateTool,
      memoryWriteTool,
      readArtifactTool,
      taskTool,
    ];
    const names = filterToolNames(tools, "plan").sort();
    expect(names).toEqual(
      [
        "glob",
        "grep",
        "ls",
        "memory_write",
        "plan_update",
        "read_artifact",
        "read_file",
      ].sort()
    );
  });

  it("plan mode forbids bash/write_file/edit_file/task", () => {
    const tools = [bashTool, writeFileTool, editFileTool, taskTool];
    expect(filterToolNames(tools, "plan")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const tools = [readFileTool, bashTool];
    const before = [...tools];
    filterToolsByMode(tools, "chat");
    expect(tools).toEqual(before);
  });

  it("returns read-tier MCP tools in restricted modes", () => {
    const mcpRead: ToolDef = {
      name: "mcp__docs__search",
      description: "search the docs",
      inputSchema: z.object({ q: z.string() }),
      permission: "read",
      async execute() {
        return { content: "ok" };
      },
    };
    const mcpNet: ToolDef = {
      name: "mcp__x__post",
      description: "post x",
      inputSchema: z.object({}),
      permission: "network",
      async execute() {
        return { content: "ok" };
      },
    };
    // Chat: keep read-tier MCP, drop network-tier MCP.
    const chat = filterToolsByMode([mcpRead, mcpNet], "chat").map((t) => t.name);
    expect(chat).toEqual(["mcp__docs__search"]);
    // Agent: keep everything.
    const agent = filterToolsByMode([mcpRead, mcpNet], "agent").map((t) => t.name);
    expect(agent).toEqual(["mcp__docs__search", "mcp__x__post"]);
  });
});

describe("filterToolsByModeFromRegistry", () => {
  it("reflects the registry's tools (with filtering)", () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    r.register(bashTool);
    r.register(planUpdateTool);
    expect(filterToolNames(r.all(), "chat").sort()).toEqual(["read_file"]);
    expect(filterToolNames(r.all(), "plan").sort()).toEqual([
      "plan_update",
      "read_file",
    ]);
    expect(filterToolNames(r.all(), "agent").sort()).toEqual([
      "bash",
      "plan_update",
      "read_file",
    ]);
  });

  it("convenience helper agrees with the raw function", () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    r.register(writeFileTool);
    r.register(memoryWriteTool);
    expect(filterToolsByModeFromRegistry(r, "plan").map((t) => t.name)).toEqual(
      filterToolsByMode(r.all(), "plan").map((t) => t.name)
    );
  });
});