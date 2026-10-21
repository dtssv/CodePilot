// Tests for the extended permission rule system.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PermissionEngine,
  matchRule,
  persistRule,
  stripLeadingCd,
} from "../src/permissions.js";
import { resolveSandbox } from "../src/sandbox.js";
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

describe("stripLeadingCd / normalizeBashPrimary", () => {
  it("strips leading cd and echo noise prefixes", () => {
    expect(stripLeadingCd("cd /repo && grep -rn TODO src")).toBe("grep -rn TODO src");
    expect(stripLeadingCd(`cd "/repo/with space" && wc -l a.ts`)).toBe("wc -l a.ts");
    expect(stripLeadingCd("cd src; ls")).toBe("ls");
    expect(stripLeadingCd("grep foo")).toBe("grep foo");
    expect(
      stripLeadingCd(`cd /tmp && echo "=== TODO ===" && grep -rn TODO packages | head -40`),
    ).toBe("grep -rn TODO packages | head -40");
  });
});

describe("scoped rules", () => {
  it("bash(prefix *) matches command prefixes", () => {
    expect(matchRule("bash(npm test *)", "bash", { command: "npm test -- --watch" })).toBe(true);
    expect(matchRule("bash(npm test *)", "bash", { command: "npm run build" })).toBe(false);
 // scoped rule must not leak to other tools
    expect(matchRule("bash(npm test *)", "read_file", { path: "npm test x" })).toBe(false);
  });

  it("bash(grep *) matches after a leading cd && chain", () => {
    expect(
      matchRule("bash(grep *)", "bash", {
        command: "cd /Users/zyf/workspace/java/CodePilot && grep -rn TODO packages",
      }),
    ).toBe(true);
    const e = new PermissionEngine({
      permissionMode: "ask",
      autoApprove: ["bash(grep *)", "bash(wc *)"],
    });
    const t = makeTool("bash", "execute");
    expect(
      e.preflight(t, {
        command: "cd /tmp && echo \"=== x ===\" && grep -rn TODO packages | head -40",
      }),
    ).toEqual({ decision: "allow", reason: 'matched allow rule "bash(grep *)"' });
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
  it("always-allow on bash grants EVERY bash command for the session", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("bash", "execute");
    expect(e.preflight(t, { command: "npm test -- --watch" })).toBe("ask");
 // "always allow" → bare tool grant, so any later command is allowed.
    e.addSessionRule(PermissionEngine.suggestRule(t, { command: "npm test -- --watch" }));
    expect(PermissionEngine.suggestRule(t, { command: "npm test -- --watch" })).toBe("bash");
    expect(e.preflight(t, { command: "npm test" })).toMatchObject({ decision: "allow" });
    expect(e.preflight(t, { command: "ls -la" })).toMatchObject({ decision: "allow" });
    expect(e.preflight(t, { command: "node build.js" })).toMatchObject({ decision: "allow" });
  });

  it("a blanket bash grant still prompts for genuinely dangerous commands", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("bash", "execute");
    e.addSessionRule("bash"); // the "always allow" grant
 // Safe commands auto-allow…
    expect(e.preflight(t, { command: "echo hi" })).toMatchObject({ decision: "allow" });
 // …but dangerous ones still require confirmation despite the grant.
    expect(e.preflight(t, { command: "rm -rf /" })).toBe("ask");
  });

  it("a precise user-authored bash rule is honoured as-is (no danger carve-out)", () => {
    const e = new PermissionEngine({ permissionMode: "ask", permissions: { allow: ["bash(git push *)"] } });
    const t = makeTool("bash", "execute");
 // A specific rule the user wrote is trusted even if the command scans as risky.
    expect(e.preflight(t, { command: "git push --force origin main" })).toMatchObject({ decision: "allow" });
  });

  it("suggestRule falls back to the bare tool name without a primary arg", () => {
    const t = makeTool("task", "execute");
    expect(PermissionEngine.suggestRule(t, { objective: "x" })).toBe("task");
  });

  it("always-allow on a file tool grants the whole tool, not a single path", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("write_file", "write");
 // "always allow" should produce a bare tool-name rule...
    const rule = PermissionEngine.suggestRule(t, { path: "/repo/a.ts", content: "x" });
    expect(rule).toBe("write_file");
    e.addSessionRule(rule);
 // ...so a DIFFERENT file is no longer asked about.
    expect(e.preflight(t, { path: "/repo/a.ts", content: "x" })).toMatchObject({ decision: "allow" });
    expect(e.preflight(t, { path: "/elsewhere/b.ts", content: "y" })).toMatchObject({ decision: "allow" });
  });
});

describe("sandbox-confined writes", () => {
  it("auto-allows writes inside the sandbox writable roots, asks outside", () => {
    const cwd = "/repo";
    const e = new PermissionEngine({ permissionMode: "ask" });
    e.setSandbox(resolveSandbox({ mode: "workspace-write" }, cwd), cwd);
    const t = makeTool("write_file", "write");
 // Inside cwd → auto-allowed (the process sandbox already confines it).
    expect(e.preflight(t, { path: "/repo/src/a.ts", content: "x" })).toMatchObject({
      decision: "allow",
    });
 // Outside the writable roots → still asks.
    expect(e.preflight(t, { path: "/etc/x.conf", content: "x" })).toBe("ask");
    const req = e.buildRequest("r1", t, { path: "/other/proj/a.ts", content: "x" });
    expect(req.sandboxExpand?.path).toBe("/other/proj");
    expect(req.reason).toMatch(/writablePaths/);
  });

  it("asks to expand sandbox even in yolo mode for out-of-root writes", () => {
    const cwd = "/repo";
    const e = new PermissionEngine({ permissionMode: "yolo" });
    e.setSandbox(resolveSandbox({ mode: "workspace-write" }, cwd), cwd);
    const t = makeTool("write_file", "write");
    expect(e.preflight(t, { path: "/repo/ok.ts", content: "x" })).toMatchObject({
      decision: "allow",
    });
    expect(e.preflight(t, { path: "/elsewhere/x.ts", content: "x" })).toBe("ask");
  });

  it("does not auto-allow writes when no sandbox is wired", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("write_file", "write");
    expect(e.preflight(t, { path: "/repo/src/a.ts", content: "x" })).toBe("ask");
  });

  it("auto-allows ordinary bash in an active sandbox, but still asks for dangerous commands", () => {
    const cwd = "/repo";
    const e = new PermissionEngine({ permissionMode: "ask" });
    // Force osEnforced: CI Linux runners often have no seatbelt/bwrap, which
    // would otherwise leave this branch untested and return "ask".
    e.setSandbox(resolveSandbox({ mode: "workspace-write" }, cwd), cwd, {
      osEnforced: true,
    });
    const t = makeTool("bash", "execute");
 // Ordinary command → auto-allowed (the OS sandbox already jails it).
    expect(e.preflight(t, { command: "echo hi > /repo/x.txt" })).toMatchObject({ decision: "allow" });
    expect(e.preflight(t, { command: "npm test" })).toMatchObject({ decision: "allow" });
 // Dangerous command → still prompts despite the sandbox.
    expect(e.preflight(t, { command: "rm -rf /" })).toBe("ask");
  });

  it("does not auto-allow bash when no sandbox is wired", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    const t = makeTool("bash", "execute");
 // Without an enforcing sandbox, every command still requires approval.
    expect(e.preflight(t, { command: "npm install" })).toBe("ask");
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
