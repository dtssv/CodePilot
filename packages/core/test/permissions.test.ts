import { describe, expect, it } from "vitest";
import { PermissionEngine, matchRule } from "../src/permissions.js";
import { ToolRegistry } from "../src/tools/types.js";
import { z } from "zod";
import type { ToolDef } from "../src/tools/types.js";
import { readFileTool, bashTool, writeFileTool } from "../src/tools/index.js";

function makeTool(name: string, perm: "read" | "write" | "execute" | "network"): ToolDef {
  return {
    name,
    description: "test",
    inputSchema: z.object({}),
    permission: perm,
    async execute() {
      return { content: "ok" };
    },
  };
}

describe("PermissionEngine", () => {
  it("auto-allows read tools in any mode", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const tool = makeTool("r", "read");
    expect(e.preflight(tool, {})).toEqual({ decision: "allow", reason: "read-only tool" });
  });

  it("yolo mode allows everything", () => {
    const e = new PermissionEngine({ permissionMode: "yolo" });
    const tool = makeTool("rm", "execute");
    expect(e.preflight(tool, { command: "rm -rf /" })).toEqual({
      decision: "allow",
      reason: "permission mode is yolo",
    });
  });

  it("auto-edit allows write tools", () => {
    const e = new PermissionEngine({ permissionMode: "auto-edit" });
    const t = makeTool("w", "write");
    expect(e.preflight(t, { path: "x" })).toEqual({
      decision: "allow",
      reason: "auto-edit mode",
    });
  });

  it("asks for execute tools in default mode", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("bash", "execute");
    expect(e.preflight(t, { command: "ls" })).toBe("ask");
  });

  it("asks for write tools in default mode", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("w", "write");
    expect(e.preflight(t, {})).toBe("ask");
  });

  it("auto-approves tools named in autoApprove", () => {
    const e = new PermissionEngine({ autoApprove: ["lint", "test_*"] });
    const t1 = makeTool("lint", "execute");
    const t2 = makeTool("test_run", "execute");
    expect(e.preflight(t1, {})).toEqual({
      decision: "allow",
      reason: "matched allow rule \"lint\"",
    });
    expect(e.preflight(t2, {})).toEqual({
      decision: "allow",
      reason: "matched allow rule \"test_*\"",
    });
  });

  it("auto-approves bash commands matching a regex", () => {
    const e = new PermissionEngine({ autoApprove: ["/^git (status|log)$/"] });
    const t = makeTool("bash", "execute");
    expect(e.preflight(t, { command: "git status" })).toEqual({
      decision: "allow",
      reason: "matched allow rule \"/^git (status|log)$/\"",
    });
    expect(e.preflight(t, { command: "git push" })).toBe("ask");
  });
});

describe("matchRule", () => {
  it("matches exact tool names", () => {
    expect(matchRule("bash", "bash", {})).toBe(true);
    expect(matchRule("bash", "read", {})).toBe(false);
  });

  it("matches wildcards on tool names", () => {
    expect(matchRule("test_*", "test_foo", {})).toBe(true);
    expect(matchRule("test_*", "other_foo", {})).toBe(false);
  });

  it("matches slash-delimited regexes on bash commands", () => {
    expect(matchRule("/^ls/", "bash", { command: "ls -la" })).toBe(true);
    expect(matchRule("/^ls/", "bash", { command: "rm -rf /" })).toBe(false);
  });
});

describe("PermissionEngine with real built-in tools", () => {
  it("read_file is read-only", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    expect(e.preflight(readFileTool, { path: "x" })).toEqual({
      decision: "allow",
      reason: "read-only tool",
    });
  });

  it("bash requires ask by default", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    expect(e.preflight(bashTool, { command: "ls" })).toBe("ask");
  });

  it("write_file is auto-allowed in auto-edit", () => {
    const e = new PermissionEngine({ permissionMode: "auto-edit" });
    expect(e.preflight(writeFileTool, { path: "x" })).toEqual({
      decision: "allow",
      reason: "auto-edit mode",
    });
  });

  it("PermissionEngine with a ToolRegistry", () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    r.register(writeFileTool);
    const e = new PermissionEngine({ permissionMode: "ask" });
    expect(e.preflight(r.get("read_file")!, {})).toEqual({
      decision: "allow",
      reason: "read-only tool",
    });
    expect(e.preflight(r.get("write_file")!, { path: "x" })).toBe("ask");
  });
});
