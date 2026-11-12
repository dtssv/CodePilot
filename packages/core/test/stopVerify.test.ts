// Built-in stopVerify: mode resolve, transcript hint, prompt/tests gates.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStopTranscriptHint,
  effectiveStopVerifyMode,
  resolveStopVerifyMode,
  resolveStopVerifyForceContinue,
  runBuiltinStopVerify,
} from "../src/stopVerify.js";
import { HookEngine } from "../src/hooks.js";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

describe("resolveStopVerifyMode", () => {
  it("defaults to off (no closing judge request)", () => {
    expect(resolveStopVerifyMode(undefined)).toBe("off");
    expect(resolveStopVerifyMode(false)).toBe("off");
    expect(resolveStopVerifyMode("off")).toBe("off");
  });
  it("honours prompt / true / tests", () => {
    expect(resolveStopVerifyMode(true)).toBe("prompt");
    expect(resolveStopVerifyMode("prompt")).toBe("prompt");
    expect(resolveStopVerifyMode("tests")).toBe("tests");
  });
});

describe("effectiveStopVerifyMode", () => {
  it("stays off for the unset default (no automatic upgrade — strictly opt-in)", () => {
    // The old behaviour auto-upgraded unset→tests whenever the turn edited a
    // code-like file, which forced a test gate onto turns the user never asked
    // to verify (e.g. editing a string in a .ts file during an analysis task).
    expect(effectiveStopVerifyMode({ configured: undefined })).toBe("off");
  });
  it("honours an EXPLICIT off/false verbatim", () => {
    expect(effectiveStopVerifyMode({ configured: "off" })).toBe("off");
    expect(effectiveStopVerifyMode({ configured: false })).toBe("off");
  });
  it("passes explicit prompt/tests/true through unchanged", () => {
    expect(effectiveStopVerifyMode({ configured: "prompt" })).toBe("prompt");
    expect(effectiveStopVerifyMode({ configured: "tests" })).toBe("tests");
    expect(effectiveStopVerifyMode({ configured: true })).toBe("prompt");
  });
  it("reads the mode from the object form", () => {
    expect(effectiveStopVerifyMode({ configured: { mode: "tests" } })).toBe("tests");
    expect(effectiveStopVerifyMode({ configured: { mode: "prompt", forceContinue: true } })).toBe("prompt");
  });
});

describe("resolveStopVerifyForceContinue", () => {
  it("is false for string/boolean forms (always advisory)", () => {
    expect(resolveStopVerifyForceContinue("prompt")).toBe(false);
    expect(resolveStopVerifyForceContinue("tests")).toBe(false);
    expect(resolveStopVerifyForceContinue(true)).toBe(false);
    expect(resolveStopVerifyForceContinue(undefined)).toBe(false);
  });
  it("is true only when the object form opts in", () => {
    expect(resolveStopVerifyForceContinue({ mode: "prompt", forceContinue: true })).toBe(true);
    expect(resolveStopVerifyForceContinue({ mode: "prompt" })).toBe(false);
    expect(resolveStopVerifyForceContinue({ mode: "prompt", forceContinue: false })).toBe(false);
  });
});

describe("buildStopTranscriptHint", () => {
  it("captures the latest user + assistant turn and recent tools", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "build a login form" }],
      },
      {
        type: "tool_call",
        id: "t1",
        name: "write_file",
        input: {},
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "Done — wrote Login.tsx" }],
      },
    ];
    const hint = buildStopTranscriptHint(events);
    expect(hint).toContain("build a login form");
    expect(hint).toContain("Done — wrote Login.tsx");
    expect(hint).toContain("write_file");
  });
});

describe("runBuiltinStopVerify", () => {
  it("prompt mode blocks when forceContinue and the judge returns block JSON", async () => {
    const r = await runBuiltinStopVerify(
      "prompt",
      {
        cwd: tmpdir(),
        reason: "prompt_completed",
        stop_hook_active: false,
        stop_continue_count: 0,
        stop_continue_cap: 8,
        session_id: "s",
        transcript_hint: "user: make a button\nassistant: wrote Button.tsx",
        resolvers: {
          prompt: async () => JSON.stringify({ decision: "block", reason: "no visual check" }),
        },
      },
      { forceContinue: true },
    );
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/no visual check/);
  });

  it("prompt mode ADVISES (allow + note) by default when the judge blocks", async () => {
    const r = await runBuiltinStopVerify("prompt", {
      cwd: tmpdir(),
      reason: "prompt_completed",
      stop_hook_active: false,
      stop_continue_count: 0,
      stop_continue_cap: 8,
      session_id: "s",
      transcript_hint: "user: make a button\nassistant: wrote Button.tsx",
      resolvers: {
        prompt: async () => JSON.stringify({ decision: "block", reason: "no visual check" }),
      },
    });
    expect(r.action).toBe("allow");
    expect(r.warnings.some((w) => w.includes("no visual check"))).toBe(true);
  });

  it("prompt mode allows when judge says allow", async () => {
    const r = await runBuiltinStopVerify("prompt", {
      cwd: tmpdir(),
      reason: "prompt_completed",
      stop_hook_active: false,
      stop_continue_count: 0,
      stop_continue_cap: 8,
      session_id: "s",
      transcript_hint: "ok",
      resolvers: { prompt: async () => '{"decision":"allow"}' },
    });
    expect(r).toEqual({ action: "allow", warnings: [] });
  });

  it("prompt mode silently allows on 429 / rate-limit (no transcript warning)", async () => {
    const { isTransientJudgeFailure } = await import("../src/stopVerify.js");
    expect(
      isTransientJudgeFailure(
        'OpenAI 429: {"error":{"message":"访问限制","cause":"tokens limit for minute"}}',
      ),
    ).toBe(true);
    const r = await runBuiltinStopVerify("prompt", {
      cwd: tmpdir(),
      reason: "prompt_completed",
      stop_hook_active: false,
      stop_continue_count: 0,
      stop_continue_cap: 8,
      session_id: "s",
      transcript_hint: "ok",
      resolvers: {
        prompt: async () => {
          throw new Error(
            'OpenAI 429: {"error":{"cause":"tokens limit for minute","message":"访问限制"}}',
          );
        },
      },
    });
    expect(r).toEqual({ action: "allow", warnings: [] });
  });

  it("prompt mode still warns on non-transient judge failures", async () => {
    const r = await runBuiltinStopVerify("prompt", {
      cwd: tmpdir(),
      reason: "prompt_completed",
      stop_hook_active: false,
      stop_continue_count: 0,
      stop_continue_cap: 8,
      session_id: "s",
      transcript_hint: "ok",
      resolvers: {
        prompt: async () => {
          throw new Error("OpenAI 401: invalid api key");
        },
      },
    });
    expect(r.action).toBe("allow");
    expect(r.warnings[0]).toMatch(/stopVerify=prompt failed:.*401/);
  });

  it("tests mode blocks when the detected test command fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-test-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          scripts: { test: "node -e \"process.exit(1)\"" },
        }),
        "utf8",
      );
      const r = await runBuiltinStopVerify(
        "tests",
        {
          cwd: dir,
          reason: "prompt_completed",
          stop_hook_active: false,
          stop_continue_count: 0,
          stop_continue_cap: 8,
          session_id: "s",
          transcript_hint: "",
          resolvers: {},
        },
        { forceContinue: true },
      );
      expect(r.action).toBe("block");
      expect(r.reason).toMatch(/test/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // These pin the auto-probe test ladder: the probe detects a project's test
  // command and allows it. Without a contract here the probe order / allow-paths
  // could silently drift.
  function testsCtx(dir: string) {
    return {
      cwd: dir,
      reason: "prompt_completed",
      stop_hook_active: false,
      stop_continue_count: 0,
      stop_continue_cap: 8,
      session_id: "s",
      transcript_hint: "",
      resolvers: {},
    };
  }

  it("tests mode ALLOWS when no test command can be detected (nothing to run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-none-"));
    try {
      // No package.json, no Cargo/go/pytest/gradle marker → nothing to run.
      const r = await runBuiltinStopVerify("tests", testsCtx(dir));
      expect(r).toEqual({ action: "allow", warnings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tests mode ALLOWS when the detected test command passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-pass-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(0)\"" } }),
        "utf8",
      );
      const r = await runBuiltinStopVerify("tests", testsCtx(dir));
      expect(r).toEqual({ action: "allow", warnings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tests mode prefers test:unit over the generic test script", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-unit-"));
    try {
      // If the ladder ran plain `test` it would PASS (exit 0) → allow. We make
      // only test:unit fail, so a block proves test:unit was the one chosen.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          scripts: {
            "test:unit": "node -e \"process.exit(3)\"",
            test: "node -e \"process.exit(0)\"",
          },
        }),
        "utf8",
      );
      const r = await runBuiltinStopVerify("tests", testsCtx(dir), { forceContinue: true });
      expect(r.action).toBe("block");
      expect(r.reason).toMatch(/test:unit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tests mode ignores the npm-init placeholder test script (nothing real to run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-ph-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
        }),
        "utf8",
      );
      const r = await runBuiltinStopVerify("tests", testsCtx(dir));
      // The placeholder must NOT be treated as a real gate (it always exits 1).
      expect(r).toEqual({ action: "allow", warnings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Session built-in stopVerify", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("continues the turn when prompt verify blocks once (forceContinue)", async () => {
    dir = mkdtempSync(join(tmpdir(), "sv-sess-"));
    let streamCalls = 0;
    let judgeCalls = 0;
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        yield { kind: "text_delta", messageId: `m${streamCalls}`, text: `pass ${streamCalls}` };
        yield { kind: "done", finishReason: "stop" };
      },
    };

    session = new Session(`test_sv_${Date.now()}`, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        retryAbortOnDelayMs: 1,
        stopVerify: { mode: "prompt", forceContinue: true },
        stopHookBlockCap: 8,
      },
      model: "mock-model",
      provider,
      pluginRuntimes: false,
    });
    await session.init();
    await session.setTitle("sv");
    // registerBuiltins already wired the default small-model judge; replace it.
    session["hooks"].setResolvers({
      prompt: async () => {
        judgeCalls += 1;
        if (judgeCalls === 1) {
          return JSON.stringify({ decision: "block", reason: "missing verification" });
        }
        return JSON.stringify({ decision: "allow" });
      },
    });

    const events: Event[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("ship the UI");

    expect(streamCalls).toBe(2);
    expect(judgeCalls).toBe(2);
    expect(events.some((e) => e.type === "stop_continue")).toBe(true);
    const userMsgs = events.filter(
      (e): e is Extract<Event, { type: "message" }> =>
        e.type === "message" && e.role === "user",
    );
    // Only the real user prompt — stopVerify continue must not fake a user bubble.
    expect(userMsgs).toHaveLength(1);
    expect(
      userMsgs.some((m) =>
        m.content.some((b) => b.type === "text" && b.text.includes("missing verification")),
      ),
    ).toBe(false);
  });

  it("does NOT re-run on a block when advisory (default); surfaces a notice instead", async () => {
    dir = mkdtempSync(join(tmpdir(), "sv-advise-"));
    let streamCalls = 0;
    let judgeCalls = 0;
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        yield { kind: "text_delta", messageId: `m${streamCalls}`, text: `pass ${streamCalls}` };
        yield { kind: "done", finishReason: "stop" };
      },
    };

    session = new Session(`test_sv_advise_${Date.now()}`, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        retryAbortOnDelayMs: 1,
        // Plain "prompt" is advisory by default.
        stopVerify: "prompt",
      },
      model: "mock-model",
      provider,
      pluginRuntimes: false,
    });
    await session.init();
    await session.setTitle("sv");
    session["hooks"].setResolvers({
      prompt: async () => {
        judgeCalls += 1;
        return JSON.stringify({ decision: "block", reason: "missing verification" });
      },
    });

    const events: Event[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("ship the UI");

    // The turn ended after one model pass — no forced re-run.
    expect(streamCalls).toBe(1);
    expect(judgeCalls).toBe(1);
    expect(events.some((e) => e.type === "stop_continue")).toBe(false);
    // The concern is surfaced as a (recoverable) advisory notice.
    const advice = events.find(
      (e) => e.type === "error" && e.message.includes("missing verification"),
    );
    expect(advice).toBeTruthy();
    expect(advice && advice.type === "error" && advice.message.includes("advisory")).toBe(true);
  });
});

describe("HookEngine.runSubagentStop block", () => {
  it("blocks on exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "substop-"));
    try {
      const script = join(dir, "block.sh");
      writeFileSync(script, "#!/bin/sh\necho 'incomplete findings' >&2\nexit 2\n", "utf8");
      chmodSync(script, 0o755);
      const h = new HookEngine(
        { SubagentStop: [{ matcher: "*", command: script }] },
        dir,
      );
      h.setTrustFile(join(dir, "hook_trust.json"));
      await h.approveHook(script);
      await h.loadTrustedHashes();
      const r = await h.runSubagentStop("explore", "### Findings\n- nothing");
      expect(r.action).toBe("block");
      expect(r.reason).toMatch(/incomplete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
