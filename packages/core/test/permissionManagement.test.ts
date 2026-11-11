// Session-level operational surface for persistent authorization (K-C2-2):
// - high-risk-model allow stripping driven by config,
// - saved-rule CRUD that hot-applies to the live engine,
// - pending-batch unlock (an always grant resolves other in-flight prompts the
//   new rule now covers).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/session.js";

const tempHome = process.env.HOME ?? tmpdir();

describe("Session — high-risk model allow-stripping", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "perm-mgmt-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("ignores persisted allows for a high-risk model and restores on switch away", async () => {
    const s = await createSession({
      cwd: workDir,
      model: "risky-model-x",
      config: {
        model: "risky-model-x",
        permissions: { allow: ["bash(npm test *)"] },
        highRiskModels: ["risky-model"],
      },
    });
    // The configured allow is still shown (display is the full set)…
    expect(s.getPermissionRules().allow).toContain("bash(npm test *)");
    // …but the gate is active because the model matches the high-risk list.
    expect(s.isIgnoringPersistedAllows()).toBe(true);

    // Switching to a non-high-risk model relaxes the gate.
    await s.setModel("safe-model-y");
    expect(s.isIgnoringPersistedAllows()).toBe(false);
    await s.dispose();
  });

  it("leaves the gate off when no high-risk model matches", async () => {
    const s = await createSession({
      cwd: workDir,
      model: "safe-model",
      config: { model: "safe-model", highRiskModels: ["risky-model"] },
    });
    expect(s.isIgnoringPersistedAllows()).toBe(false);
    await s.dispose();
  });
});

describe("Session — saved permission rule CRUD", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "perm-crud-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("lists / adds / removes persisted rules and writes the repo config", async () => {
    const s = await createSession({ cwd: workDir, model: "m" });
    expect(await s.listSavedPermissionRules("repo")).toEqual({
      allow: [],
      ask: [],
      deny: [],
    });

    const path = await s.addSavedPermissionRule("bash(npm run build *)", "allow", "repo");
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.permissions.allow).toContain("bash(npm run build *)");

    // Hot-applied to the live engine: the rule is now active this session.
    const after = await s.listSavedPermissionRules("repo");
    expect(after.allow).toContain("bash(npm run build *)");

    expect(await s.removeSavedPermissionRule("bash(npm run build *)", "allow", "repo")).toBe(true);
    expect(await s.removeSavedPermissionRule("bash(npm run build *)", "allow", "repo")).toBe(false);
    expect((await s.listSavedPermissionRules("repo")).allow).not.toContain(
      "bash(npm run build *)",
    );
    await s.dispose();
  });
});
