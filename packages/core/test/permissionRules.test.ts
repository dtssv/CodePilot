// Tests for the extended permission rule system.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionEngine, matchRule, persistRule } from "../src/permissions.js";
import type { ToolDef } from "../src/tools/types.js";
import { z } from "zod";

function makeTool(name: string, permission: "read" | "write" | "execute" | "network"): ToolDef {
  return {
    name,
    description: "",
    inputSchema: z.object({}).passthrough(),
    permission,
    execute: async () => ({ content: "" }),
  };
}

describe("scoped rules", () => {
  it("bash(prefix *) matches command prefixes", () => {
    expect(matchRule("bash(npm test *)", "bash", { command: "npm test -- --watch" })).toBe(true);
    expect(matchRule("bash(npm test *)", "bash", { command: "npm run build" })).toBe(false);
    // scoped rule must not leak to other tools
    expect(matchRule("bash(npm test *)", "read_file", { path: "npm test x" })).toBe(false);
  });

  it("tool(/regex/) matches the primary argument", () => {
    expect(matchRule("bash(/^git (status|diff)/)", "bash", { command: "git diff HEAD" })).toBe(true);
    expect(matchRule("bash(/^git (status|diff)/)", "bash", { command: "git push" })).toBe(false);
  });

  it("scoped rules match on path for file tools", () => {
    expect(matchRule("read_file(src/*)", "read_file", { path: "src/a.ts" })).toBe(true);
    expect(matchRule("read_file(src/*)", "read_file", { path: "docs/a.md" })).toBe(false);
  });
});

describe("evaluation order: deny > ask > allow > mode", () => {
  it("deny wins over allow and yolo", () => {
    const e = new PermissionEngine({
      permissionMode: "yolo",
      permissions: {
        allow: ["bash"],
        deny: ["bash(rm -rf *)"],
      },
    });
    const t = makeTool("bash", "execute");
    expect(e.preflight(t, { command: "ls" })).toEqual({
      decision: "allow",
      reason: 'matched allow rule "bash"',
    });
    const denied = e.preflight(t, { command: "rm -rf ./node_modules" });
    expect(denied).toEqual({
      decision: "deny",
      reason: 'matched deny rule "bash(rm -rf *)"',
    });
  });

  it("ask rules force a prompt even when an allow rule would match later", () => {
    const e = new PermissionEngine({
      permissionMode: "yolo",
      permissions: { ask: ["bash(git push *)"] },
    });
    const t = makeTool("bash", "execute");
    expect(e.preflight(t, { command: "git push origin main" })).toBe("ask");
  });

  it("dangerous commands force ask even in yolo without an allow rule", () => {
    const e = new PermissionEngine({ permissionMode: "yolo" });
    const t = makeTool("bash", "execute");
    expect(e.preflight(t, { command: "git push --force" })).toBe("ask");
    expect(e.preflight(t, { command: "npm test" })).toEqual({
      decision: "allow",
      reason: "permission mode is yolo",
    });
  });

  it("deny applies to non-bash tools as well", () => {
    const e = new PermissionEngine({
      permissionMode: "yolo",
      permissions: { deny: ["edit_file(*.env)"] },
    });
    const t = makeTool("edit_file", "write");
    expect(e.preflight(t, { path: ".env" })).toEqual({
      decision: "deny",
      reason: 'matched deny rule "edit_file(*.env)"',
    });
  });
});

describe("session rules (always decisions)", () => {
  it("addSessionRule narrows future identical invocations", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("bash", "execute");
    expect(e.preflight(t, { command: "npm test -- --watch" })).toBe("ask");
    e.addSessionRule(PermissionEngine.suggestRule(t, { command: "npm test -- --watch" }));
    expect(e.preflight(t, { command: "npm test" })).toEqual({
      decision: "allow",
      reason: 'matched allow rule "bash(npm test *)"',
    });
    // but a different command still asks
    expect(e.preflight(t, { command: "npm publish" })).toBe("ask");
  });

  it("suggestRule falls back to the bare tool name without a primary arg", () => {
    const t = makeTool("task", "execute");
    expect(PermissionEngine.suggestRule(t, { objective: "x" })).toBe("task");
  });
});

describe("persistRule", () => {
  it("writes into .codepilot/config.json and merges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cpperm-"));
    await persistRule(dir, "bash(npm test *)", "allow");
    await persistRule(dir, "bash(rm -rf *)", "deny");
    const json = JSON.parse(
      await readFile(join(dir, ".codepilot", "config.json"), "utf-8")
    );
    expect(json.permissions.allow).toContain("bash(npm test *)");
    expect(json.permissions.deny).toContain("bash(rm -rf *)");
    // idempotent
    await persistRule(dir, "bash(npm test *)", "allow");
    const again = JSON.parse(
      await readFile(join(dir, ".codepilot", "config.json"), "utf-8")
    );
    expect(again.permissions.allow.filter((r: string) => r === "bash(npm test *)")).toHaveLength(1);
  });
});
