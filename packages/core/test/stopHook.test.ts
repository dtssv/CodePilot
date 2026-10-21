// Stop hook: can block ending a turn; session continues with feedback (capped).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "../src/hooks.js";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

describe("HookEngine.runStop", () => {
  it("allows immediately when no Stop hooks are configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stop-"));
    try {
      const h = new HookEngine({}, dir);
      await h.loadTrustedHashes();
      expect(await h.runStop({ reason: "prompt_completed" })).toEqual({
        action: "allow",
        warnings: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks on exit code 2 and surfaces stderr as reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stop-"));
    try {
      const script = join(dir, "block.sh");
      writeFileSync(script, "#!/bin/sh\necho 'tests failed' >&2\nexit 2\n", "utf8");
      chmodSync(script, 0o755);
      const h = new HookEngine(
        { Stop: [{ matcher: "*", command: script }] },
        dir,
      );
      h.setTrustFile(join(dir, "hook_trust.json"));
      await h.approveHook(script);
      await h.loadTrustedHashes();
      const r = await h.runStop({ reason: "prompt_completed", stop_hook_active: false });
      expect(r.action).toBe("block");
      expect(r.reason).toMatch(/tests failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows on exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stop-"));
    try {
      const script = join(dir, "ok.sh");
      writeFileSync(script, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(script, 0o755);
      const h = new HookEngine({ Stop: [{ matcher: "*", command: script }] }, dir);
      h.setTrustFile(join(dir, "hook_trust.json"));
      await h.approveHook(script);
      await h.loadTrustedHashes();
      expect(await h.runStop({})).toMatchObject({ action: "allow" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Session Stop continue loop", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("re-enters the agent when Stop blocks, then ends when it allows", async () => {
    dir = mkdtempSync(join(tmpdir(), "stop-sess-"));
    const counter = join(dir, "stop-count");
    writeFileSync(counter, "0", "utf8");
    const script = join(dir, "once-block.sh");
    // Block the first Stop invocation; allow thereafter.
    writeFileSync(
      script,
      `#!/bin/sh
n=$(cat "${counter}")
n=$((n+1))
echo "$n" > "${counter}"
if [ "$n" -eq 1 ]; then
  echo "need another pass" >&2
  exit 2
fi
exit 0
`,
      "utf8",
    );
    chmodSync(script, 0o755);

    let streamCalls = 0;
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

    session = new Session(`test_stop_${Date.now()}`, {
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
        hooks: { Stop: [{ matcher: "*", command: script }] },
        stopHookBlockCap: 8,
        stopVerify: "off",
      },
      model: "mock-model",
      provider,
      pluginRuntimes: false,
    });
    await session.init();
    await session.setTitle("stop-test"); // skip small-model title fetch
    // Trust the Stop script (init loads empty trust file).
    await session["hooks"].approveHook(script);

    const events: Event[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("do the thing");

    expect(streamCalls).toBe(2);
    const userTexts = events
      .filter((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user")
      .map((e) => e.content.find((b) => b.type === "text" && "text" in b)?.text ?? "");
    expect(userTexts[0]).toBe("do the thing");
    expect(userTexts.some((t) => t.includes("stop_hook_continue") && t.includes("need another pass"))).toBe(
      true,
    );
  });

  it("forces end after stopHookBlockCap continues", async () => {
    dir = mkdtempSync(join(tmpdir(), "stop-cap-"));
    const script = join(dir, "always-block.sh");
    writeFileSync(script, "#!/bin/sh\necho always >&2\nexit 2\n", "utf8");
    chmodSync(script, 0o755);

    let streamCalls = 0;
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        yield { kind: "text_delta", messageId: `m${streamCalls}`, text: "x" };
        yield { kind: "done", finishReason: "stop" };
      },
    };

    session = new Session(`test_stop_cap_${Date.now()}`, {
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
        hooks: { Stop: [{ matcher: "*", command: script }] },
        stopHookBlockCap: 2,
        stopVerify: "off",
      },
      model: "mock-model",
      provider,
      pluginRuntimes: false,
    });
    await session.init();
    await session.setTitle("stop-cap");
    await session["hooks"].approveHook(script);

    await session.prompt("go");

    // Initial run + 2 continues = 3 streams; then cap forces end.
    expect(streamCalls).toBe(3);
  });
});
