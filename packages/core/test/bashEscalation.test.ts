// Per-command sandbox escalation (bash `escalate_sandbox: true`): the one
// command runs WITHOUT the OS jail and bypasses the (jailed) persistent shell,
// while the session policy is unchanged. The permission gate for escalation is
// tested in permissions.test.ts; here we test the bash tool's execution path.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bashTool } from "../src/tools/index.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

describe("bash per-command sandbox escalation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cp-esc-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A persistent shell that records whether it was used. Under a real jail this
  // shell IS the sandbox; an escalated command must NOT go through it.
  function mockPersistentShell() {
    const calls: string[] = [];
    return {
      calls,
      run: async (command: string) => {
        calls.push(command);
        return { stdout: "[persistent]", stderr: "", exitCode: 0, signal: null, timedOut: false };
      },
    };
  }

  function ctx(ps?: ReturnType<typeof mockPersistentShell>): ToolContext {
    return {
      cwd: dir,
      artifact: async () => "art_x",
      readArtifact: async () => "",
      // workspace-write is the normal (jailed) policy; escalation overrides it.
      sandbox: resolveSandbox({ mode: "workspace-write" }, dir),
      persistentShell: ps,
    } as ToolContext;
  }

  it("a normal command uses the persistent shell", async () => {
    const ps = mockPersistentShell();
    const res = await bashTool.execute({ command: "echo normal" }, ctx(ps));
    expect(ps.calls).toEqual(["echo normal"]);
    expect(res.content).toContain("[persistent]");
  });

  it("an escalated command BYPASSES the persistent shell and runs unsandboxed", async () => {
    const ps = mockPersistentShell();
    const res = await bashTool.execute(
      { command: "echo escalated-out", escalate_sandbox: true, justification: "needs host" },
      ctx(ps),
    );
    // Did NOT touch the jailed persistent shell.
    expect(ps.calls).toEqual([]);
    // Actually ran the command (one-shot, unsandboxed).
    expect(res.content).toContain("escalated-out");
    expect(res.isError).toBeFalsy();
  });

  it("escalation does not mutate the session policy (ephemeral)", async () => {
    const c = ctx();
    const policyBefore = c.sandbox;
    await bashTool.execute(
      { command: "echo x", escalate_sandbox: true, justification: "j" },
      c,
    );
    // Same object, mode untouched — escalation only loosened a local copy.
    expect(c.sandbox).toBe(policyBefore);
    expect(c.sandbox?.mode).toBe("workspace-write");
  });

  it("marks an escalated background job as UNSANDBOXED", async () => {
    const start = await bashTool.execute(
      {
        command: "sleep 0.1",
        run_in_background: true,
        escalate_sandbox: true,
        justification: "dev server",
      },
      ctx(),
    );
    expect(start.content).toContain("UNSANDBOXED — escalated");
    const id = start.content.match(/job_[a-f0-9]{8}/)?.[0];
    if (id) {
      const { bashKillTool } = await import("../src/tools/index.js");
      await bashKillTool.execute({ job_id: id }, ctx());
    }
  });
});
