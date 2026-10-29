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

  it("skips an unapproved http hook without POSTing the payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooktrust-"));
    // A URL that would obviously fail (and reveal exfiltration) if the request
    // were ever made; the trust gate must short-circuit before any network I/O.
    const engine = new HookEngine(
      { PreToolUse: [{ matcher: "*", http: "http://127.0.0.1:9/hook" }] },
      dir,
    );
    engine.setTrustFile(join(dir, "hook_trust.json"));
    await engine.loadTrustedHashes();
    const warnings: string[] = [];
    engine.onWarning = (m) => warnings.push(m);

    // Skipped untrusted hook → fail-safe allow, no decision from the endpoint.
    expect((await engine.runPreToolUse("bash", {})).action).toBe("allow");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/PreToolUse hook "http:\/\/127\.0\.0\.1:9\/hook" skipped: hook http not trusted/);
  });

  it("gates http hooks by method+URL+headers and honours approveHookEntry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooktrust-"));
    const hook = {
      matcher: "*",
      http: "http://127.0.0.1:9/hook",
      httpHeaders: { Authorization: "Bearer x" },
    };
    const engine = new HookEngine({ PreToolUse: [hook] }, dir);
    engine.setTrustFile(join(dir, "hook_trust.json"));
    await engine.loadTrustedHashes();

    // Approving the bare URL string must NOT satisfy the header-bearing subject.
    await engine.approveHook("http://127.0.0.1:9/hook");
    expect(engine.isTrusted(hook as never)).toBe(false);

    // Approving the full entry (URL + headers) does.
    await engine.approveHookEntry(hook as never);
    expect(engine.isTrusted(hook as never)).toBe(true);
  });

  it("never gates exempt handler types (mcp_tool/prompt/agent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooktrust-"));
    const engine = new HookEngine({}, dir);
    engine.setTrustFile(join(dir, "hook_trust.json"));
    await engine.loadTrustedHashes();
    expect(engine.isTrusted({ matcher: "*", mcpTool: "srv:tool" } as never)).toBe(true);
    expect(engine.isTrusted({ matcher: "*", prompt: "review" } as never)).toBe(true);
    expect(engine.isTrusted({ matcher: "*", agent: "do-it" } as never)).toBe(true);
  });
});
