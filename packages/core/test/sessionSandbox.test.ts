// Session.setSandboxMode: hot-apply a sandbox-mode change to a live session.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/session.js";

const tempHome = process.env.HOME ?? tmpdir();

describe("Session — setSandboxMode (live sandbox switch)", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "sbx-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("defaults to workspace-write and reports status", async () => {
    const s = await createSession({ cwd: workDir });
    expect(s.getSandbox().mode).toBe("workspace-write");
    expect(s.getSandboxStatus().mode).toBe("workspace-write");
    await s.dispose();
  });

  it("hot-applies mode:off to the live session", async () => {
    const s = await createSession({ cwd: workDir });
    const status = s.setSandboxMode("off");
    expect(status.mode).toBe("off");
    // Policy actually re-resolved — not just the status string.
    expect(s.getSandbox().mode).toBe("off");
    // With the sandbox off there is no "unavailable" condition regardless of
    // whether a backend exists on this host.
    expect(status.unavailable).toBe(false);
    await s.dispose();
  });

  it("switches off → read-only → workspace-write and the policy follows", async () => {
    const s = await createSession({ cwd: workDir });
    s.setSandboxMode("off");
    expect(s.getSandbox().mode).toBe("off");
    s.setSandboxMode("read-only");
    expect(s.getSandbox().mode).toBe("read-only");
    s.setSandboxMode("workspace-write");
    expect(s.getSandbox().mode).toBe("workspace-write");
    await s.dispose();
  });

  it("preserves other sandbox settings (writablePaths) across a mode switch", async () => {
    const extra = mkdtempSync(join(tempHome, "sbx-extra-"));
    const s = await createSession({
      cwd: workDir,
      config: { sandbox: { mode: "workspace-write", writablePaths: [extra] } },
    });
    expect(s.getSandbox().writablePaths).toContain(extra);
    s.setSandboxMode("read-only");
    // The operator's writablePaths survive the mode change.
    expect(s.getSandbox().writablePaths).toContain(extra);
    await s.dispose();
    rmSync(extra, { recursive: true, force: true });
  });
});
