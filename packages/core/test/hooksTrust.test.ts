import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookEngine } from "../src/hooks.js";

describe("hook trust", () => {
  it("skips an unapproved command hook and says so once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooktrust-"));
    const engine = new HookEngine({ PreToolUse: [{ matcher: "*", command: "exit 2" }] }, dir);
    engine.setTrustFile(join(dir, "hook_trust.json"));
    await engine.loadTrustedHashes();
    const warnings: string[] = [];
    engine.onWarning = (m) => warnings.push(m);

    expect((await engine.runPreToolUse("bash", {})).action).toBe("allow");
    await engine.runPreToolUse("bash", {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/PreToolUse hook "exit 2" skipped: .*not trusted/);
  });

  it("runs the hook once its command is approved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooktrust-"));
    const engine = new HookEngine({ PreToolUse: [{ matcher: "*", command: "exit 2" }] }, dir);
    engine.setTrustFile(join(dir, "hook_trust.json"));
    await engine.loadTrustedHashes();
    await engine.approveHook("exit 2");
    expect((await engine.runPreToolUse("bash", {})).action).toBe("block");
  });
});
