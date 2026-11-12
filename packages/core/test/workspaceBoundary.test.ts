// Workspace-boundary policy: a first-class switch for how reads/writes outside
// the working set (cwd + extra working dirs + sandbox writable roots + delivery
// roots) are handled. `ask` (default) keeps the prompt flow; `deny-write`
// hard-denies out-of-boundary writes; `deny-read-write` denies reads too. The
// same check covers file tools and bash output redirections.

import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/permissions.js";
import { resolveSandbox } from "../src/sandbox.js";
import { extractRedirectWriteTargets } from "../src/commandSafety.js";
import { z } from "zod";
import type { ToolDef } from "../src/tools/types.js";

const CWD = "/repo/project";

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

/** An engine wired with a sandbox so the working set is cwd-based. */
function engine(
  boundary: "ask" | "deny-write" | "deny-read-write",
  extra?: string[],
): PermissionEngine {
  const e = new PermissionEngine({
    permissionMode: "yolo", // prove the floor beats even yolo
    permissions: { workspaceBoundary: boundary, additionalWorkingDirectories: extra },
  });
  e.setSandbox(resolveSandbox({ mode: "workspace-write" }, CWD), CWD, { osEnforced: true });
  return e;
}

describe("workspaceBoundary — default ask", () => {
  it("does not hard-deny an out-of-boundary write (keeps the ask flow)", () => {
    const e = engine("ask");
    const w = makeTool("write_file", "write");
    // Under yolo + ask boundary, an out-of-root write forces "ask" (the
    // sandbox-expand path), never a boundary deny.
    const d = e.preflight(w, { path: "/opt/outside/x.txt" });
    expect(d).toBe("ask");
  });
});

describe("workspaceBoundary — deny-write", () => {
  it("hard-denies a write outside the working set", () => {
    const e = engine("deny-write");
    const w = makeTool("write_file", "write");
    const d = e.preflight(w, { path: "/opt/outside/x.txt" });
    expect(d).toMatchObject({ decision: "deny" });
    expect((d as { reason: string }).reason).toMatch(/workspace boundary \(deny-write\)/);
  });

  it("allows a write inside cwd", () => {
    const e = engine("deny-write");
    const w = makeTool("write_file", "write");
    const d = e.preflight(w, { path: `${CWD}/src/a.ts` });
    // Inside the sandbox + yolo → allowed, not denied.
    expect(d).not.toBe("ask");
    expect((d as { decision: string }).decision).toBe("allow");
  });

  it("allows a write inside a configured extra working directory", () => {
    const e = engine("deny-write", ["/data/shared"]);
    const w = makeTool("write_file", "write");
    const d = e.preflight(w, { path: "/data/shared/out.txt" });
    expect((d as { decision: string }).decision).toBe("allow");
  });

  it("does NOT deny an out-of-boundary READ under deny-write", () => {
    const e = engine("deny-write");
    const r = makeTool("read_file", "read");
    const d = e.preflight(r, { path: "/opt/outside/x.txt" });
    expect(d).toMatchObject({ decision: "allow" });
  });

  it("hard-denies a bash command that redirects output outside the boundary", () => {
    const e = engine("deny-write");
    const b = makeTool("bash", "execute");
    const d = e.preflight(b, { command: "echo hi > /opt/outside/out.txt" });
    expect(d).toMatchObject({ decision: "deny" });
    expect((d as { reason: string }).reason).toMatch(/workspace boundary/);
  });

  it("allows a bash redirect that stays inside cwd", () => {
    const e = engine("deny-write");
    const b = makeTool("bash", "execute");
    const d = e.preflight(b, { command: `echo hi > ${CWD}/out.txt` });
    expect((d as { decision: string }).decision).toBe("allow");
  });
});

describe("workspaceBoundary — deny-read-write", () => {
  it("hard-denies an out-of-boundary read", () => {
    const e = engine("deny-read-write");
    const r = makeTool("read_file", "read");
    const d = e.preflight(r, { path: "/opt/outside/x.txt" });
    expect(d).toMatchObject({ decision: "deny" });
    expect((d as { reason: string }).reason).toMatch(/deny-read-write/);
  });

  it("allows an in-boundary read", () => {
    const e = engine("deny-read-write");
    const r = makeTool("read_file", "read");
    const d = e.preflight(r, { path: `${CWD}/src/a.ts` });
    expect(d).toMatchObject({ decision: "allow" });
  });

  it("still denies an out-of-boundary write", () => {
    const e = engine("deny-read-write");
    const w = makeTool("write_file", "write");
    const d = e.preflight(w, { path: "/opt/outside/x.txt" });
    expect(d).toMatchObject({ decision: "deny" });
  });
});

describe("workspaceBoundary — delivery roots count as in-boundary", () => {
  it("allows a write under a granted delivery root", () => {
    const e = engine("deny-write");
    e.setDeliveryRoots(["/deliver/here"]);
    const w = makeTool("write_file", "write");
    const d = e.preflight(w, { path: "/deliver/here/report.md" });
    expect((d as { decision: string }).decision).toBe("allow");
  });

  it("allows a write under a runtime-added working directory", () => {
    const e = engine("deny-write");
    e.addWorkingDirectory("/later/added");
    const w = makeTool("write_file", "write");
    const d = e.preflight(w, { path: "/later/added/x.txt" });
    expect((d as { decision: string }).decision).toBe("allow");
  });
});

describe("deny rules still win over the boundary floor", () => {
  it("a deny rule outranks an in-boundary write", () => {
    const e = new PermissionEngine({
      permissionMode: "yolo",
      permissions: { workspaceBoundary: "deny-write", deny: ["write_file"] },
    });
    e.setSandbox(resolveSandbox({ mode: "workspace-write" }, CWD), CWD, { osEnforced: true });
    const w = makeTool("write_file", "write");
    const d = e.preflight(w, { path: `${CWD}/in.txt` });
    expect(d).toMatchObject({ decision: "deny" });
    expect((d as { reason: string }).reason).toMatch(/matched deny rule/);
  });
});

describe("extractRedirectWriteTargets", () => {
  it("pulls simple > and >> targets", () => {
    expect(extractRedirectWriteTargets("echo hi > out.txt")).toEqual(["out.txt"]);
    expect(extractRedirectWriteTargets("cat a >> log")).toEqual(["log"]);
  });

  it("handles fd-prefixed and &> redirects", () => {
    expect(extractRedirectWriteTargets("cmd 2> err.log")).toEqual(["err.log"]);
    expect(extractRedirectWriteTargets("cmd &> all.log")).toEqual(["all.log"]);
  });

  it("strips quotes around the target", () => {
    expect(extractRedirectWriteTargets('echo x > "with space.txt"')).toEqual(["with space.txt"]);
    expect(extractRedirectWriteTargets("echo x > 'q.txt'")).toEqual(["q.txt"]);
  });

  it("skips /dev/null and fd duplication", () => {
    expect(extractRedirectWriteTargets("cmd > /dev/null 2>&1")).toEqual([]);
    expect(extractRedirectWriteTargets("cmd 2>&1")).toEqual([]);
  });

  it("skips targets built from variables or substitution (not resolvable)", () => {
    expect(extractRedirectWriteTargets("echo x > $OUT")).toEqual([]);
    expect(extractRedirectWriteTargets("echo x > `mktemp`")).toEqual([]);
  });

  it("returns multiple targets in a chained command", () => {
    expect(extractRedirectWriteTargets("a > one.txt && b >> two.txt")).toEqual([
      "one.txt",
      "two.txt",
    ]);
  });
});
