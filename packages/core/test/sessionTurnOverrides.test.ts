import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/session.js";

const tempHome = process.env.HOME ?? tmpdir();

describe("Session — turn-scoped overrides (slash commands)", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "turn-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("getModel returns the session model by default", async () => {
    const s = await createSession({ cwd: workDir, model: "claude-sonnet-4-5" });
    expect(s.getModel()).toBe("claude-sonnet-4-5");
    await s.dispose();
  });

  it("setModel persistently changes the model", async () => {
    const s = await createSession({ cwd: workDir, model: "model-a" });
    expect(s.getModel()).toBe("model-a");
    await s.setModel("model-b");
    expect(s.getModel()).toBe("model-b");
    // Stays after the change (not turn-scoped).
    expect(s.getModel()).toBe("model-b");
    await s.dispose();
  });

  it("setModel ignores empty or identical values", async () => {
    const s = await createSession({ cwd: workDir, model: "model-a" });
    await s.setModel("model-a");
    expect(s.getModel()).toBe("model-a");
    await s.setModel("");
    expect(s.getModel()).toBe("model-a");
    await s.dispose();
  });

  it("setTurnOverrides sets a turn-scoped model override", async () => {
    const s = await createSession({ cwd: workDir, model: "session-model" });
    s.setTurnOverrides({ model: "override-model" });
    expect(s.getModel()).toBe("override-model");
    expect(s.getTurnOverrides().model).toBe("override-model");
    await s.dispose();
  });

  it("setTurnOverrides with model 'inherit' keeps the session model", async () => {
    const s = await createSession({ cwd: workDir, model: "session-model" });
    s.setTurnOverrides({ model: "inherit" });
    expect(s.getModel()).toBe("session-model");
    expect(s.getTurnOverrides().model).toBeNull();
    await s.dispose();
  });

  it("clearTurnOverrides restores the session model", async () => {
    const s = await createSession({ cwd: workDir, model: "session-model" });
    s.setTurnOverrides({ model: "override-model" });
    expect(s.getModel()).toBe("override-model");
    s.clearTurnOverrides();
    expect(s.getModel()).toBe("session-model");
    expect(s.getTurnOverrides().model).toBeNull();
    await s.dispose();
  });

  it("setTurnOverrides adds allowed-tools as session permission rules", async () => {
    const s = await createSession({ cwd: workDir, model: "m" });
    const before = s.getPermissionRules().allow.length;
    s.setTurnOverrides({ allowedTools: ["bash", "read_file"] });
    const after = s.getPermissionRules().allow.length;
    expect(after).toBe(before + 2);
    expect(s.getPermissionRules().allow).toContain("bash");
    expect(s.getPermissionRules().allow).toContain("read_file");
    await s.dispose();
  });

  it("clearTurnOverrides removes only the rules it pushed (LIFO)", async () => {
    const s = await createSession({ cwd: workDir, model: "m" });
    const baseline = s.getPermissionRules().allow.length;
    // Simulate an "always" decision (persistent session rule).
    s["permissions"].addSessionRule("grep", "allow");
    expect(s.getPermissionRules().allow.length).toBe(baseline + 1);
    // Now push turn overrides on top.
    s.setTurnOverrides({ allowedTools: ["bash", "read_file"] });
    expect(s.getPermissionRules().allow.length).toBe(baseline + 3);
    // Clear should pop exactly the 2 turn rules, leaving the "always" grep rule.
    s.clearTurnOverrides();
    expect(s.getPermissionRules().allow.length).toBe(baseline + 1);
    expect(s.getPermissionRules().allow).toContain("grep");
    expect(s.getPermissionRules().allow).not.toContain("bash");
    await s.dispose();
  });

  it("setTurnOverrides clears stale overrides before pushing new ones", async () => {
    const s = await createSession({ cwd: workDir, model: "m" });
    const baseline = s.getPermissionRules().allow.length;
    s.setTurnOverrides({ allowedTools: ["bash", "read_file", "grep"] });
    expect(s.getPermissionRules().allow.length).toBe(baseline + 3);
    // Second call should replace, not accumulate.
    s.setTurnOverrides({ allowedTools: ["web_fetch"] });
    expect(s.getPermissionRules().allow.length).toBe(baseline + 1);
    expect(s.getPermissionRules().allow).toContain("web_fetch");
    expect(s.getPermissionRules().allow).not.toContain("bash");
    await s.dispose();
  });

  it("getTurnOverrides returns nulls when nothing is set", async () => {
    const s = await createSession({ cwd: workDir, model: "m" });
    expect(s.getTurnOverrides()).toEqual({ model: null, allowedTools: null });
    await s.dispose();
  });

  it("setTurnOverrides throws after dispose", async () => {
    const s = await createSession({ cwd: workDir, model: "m" });
    await s.dispose();
    expect(() => s.setTurnOverrides({ model: "x" })).toThrow(/disposed/);
  });

  it("setModel throws after dispose", async () => {
    const s = await createSession({ cwd: workDir, model: "m" });
    await s.dispose();
    await expect(s.setModel("x")).rejects.toThrow(/disposed/);
  });
});
