// Opt-in OS-sandboxing of command hooks: runCommandHook wraps the command
// with the sandbox policy when one is passed, and leaves it untouched
// otherwise. Deterministic across platforms — we assert on the DENY stub
// (no backend + fallback:"deny") rather than requiring a real sandbox binary.

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { runCommandHook } from "../src/hooks-handlers.js";
import { resolveSandbox, detectSandboxBackend } from "../src/sandbox.js";

const cwd = tmpdir();

describe("runCommandHook sandbox", () => {
  it("runs normally with no sandbox policy (legacy behaviour)", async () => {
    const r = await runCommandHook("exit 0", {}, cwd);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("runs normally when the policy is mode:off (passthrough)", async () => {
    const policy = resolveSandbox({ mode: "off" }, cwd);
    const r = await runCommandHook("exit 0", {}, cwd, undefined, policy);
    expect(r.code).toBe(0);
  });

  it("fails closed when a sandbox is required but no OS backend exists", async () => {
    // Only meaningful on hosts without a sandbox backend; where one exists
    // the command would really run sandboxed instead.
    if (detectSandboxBackend() !== "none") return;
    const policy = resolveSandbox({ mode: "read-only", fallback: "deny" }, cwd);
    const r = await runCommandHook("echo should-not-run", {}, cwd, undefined, policy);
    expect(r.code).toBe(126); // the wrapCommand deny stub exits 126
    expect(r.stderr).toMatch(/sandbox/i);
    expect(r.stdout).not.toContain("should-not-run");
  });

  it("warns but still runs when no backend and fallback is allow-unsandboxed", async () => {
    if (detectSandboxBackend() !== "none") return;
    const policy = resolveSandbox({ mode: "read-only", fallback: "allow-unsandboxed" }, cwd);
    const r = await runCommandHook("exit 0", {}, cwd, undefined, policy);
    expect(r.code).toBe(0); // allowed through with a stderr warning
  });
});
