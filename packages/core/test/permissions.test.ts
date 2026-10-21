import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionEngine, matchRule } from "../src/permissions.js";
import { ToolRegistry } from "../src/tools/types.js";
import { z } from "zod";
import type { ToolDef } from "../src/tools/types.js";
import { readFileTool, bashTool, writeFileTool, bashKillTool } from "../src/tools/index.js";
import { resolveSandbox } from "../src/sandbox.js";

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
    expect(e.preflight(t, { command: "npm install" })).toBe("ask");
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
    expect(e.preflight(bashTool, { command: "npm install" })).toBe("ask");
  });

  it("write_file is auto-allowed in auto-edit", () => {
    const e = new PermissionEngine({ permissionMode: "auto-edit" });
    expect(e.preflight(writeFileTool, { path: "x" })).toEqual({
      decision: "allow",
      reason: "auto-edit mode",
    });
  });

  it("web_search and web_fetch auto-allow in ask mode (no local side effects)", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const search = makeTool("web_search", "network");
    const fetch = makeTool("web_fetch", "network");
    expect(e.preflight(search, { query: "x" })).toEqual({
      decision: "allow",
      reason: "network tool (no local side effects)",
    });
    expect(e.preflight(fetch, { url: "https://example.com" })).toEqual({
      decision: "allow",
      reason: "network tool (no local side effects)",
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

  it("enrichForDisplay attaches the background job command for bash_kill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "perm-job-"));
    try {
      const start = await bashTool.execute(
        { command: "sleep 30", run_in_background: true },
        {
          cwd: dir,
          artifact: async () => "a",
          readArtifact: async () => "",
          sandbox: resolveSandbox({ mode: "off" }, dir),
        },
      );
      const id = start.content.match(/job_[a-f0-9]{8}/)?.[0];
      expect(id).toBeTruthy();
      const e = new PermissionEngine({ permissionMode: "ask" });
      const req = e.buildRequest("r1", bashKillTool, { job_id: id });
      expect(JSON.stringify(req.input)).toContain("job_id");
      expect(JSON.stringify(req.input)).not.toContain("sleep 30");
      await e.enrichForDisplay(req, dir);
      expect((req.input as { command?: string }).command).toContain("sleep 30");
      expect(req.reason).toContain("sleep 30");
      expect(req.reason).toContain(id!);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
