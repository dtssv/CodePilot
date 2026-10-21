// Mid-turn sandbox expand restarts PersistentShell; AgentDeps must not
// keep a closed instance or bash throws "PersistentShell closed".

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";

const instantProvider: ChatProvider = {
  name: "mock",
  defaultModel: "mock",
  smallModel: "mock",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { kind: "text_delta", messageId: "m", text: "ok" };
    yield { kind: "done", finishReason: "stop" };
  },
};

type SessionInternals = {
  persistentShell: { close(): void; run(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string }> } | null;
  startPersistentShell(): NonNullable<SessionInternals["persistentShell"]> | null;
  livePersistentShellHandle():
    | { run(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string }> }
    | undefined;
};

describe("sandbox expand + persistent shell", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function makeSession() {
    dir = mkdtempSync(join(tmpdir(), "sx-"));
    session = new Session(`test_sx_${Date.now()}`, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
      },
      model: "mock-model",
      provider: instantProvider,
      pluginRuntimes: false,
    });
    await session.init();
    return session;
  }

  it("live handle still works after expandWritablePath restarts the shell", async () => {
    const s = await makeSession();
    const inner = s as unknown as SessionInternals;
    inner.persistentShell = inner.startPersistentShell();
    expect(inner.persistentShell).toBeTruthy();

    const handle = inner.livePersistentShellHandle();
    expect(handle).toBeTruthy();

    const before = await handle!.run("printf before");
    expect(before.stdout).toContain("before");

    const stale = inner.persistentShell!;
    await s.expandWritablePath(join(dir, "extra"));

    // Old instance is closed; capturing it by value throws (sync in ensureStarted).
    expect(() => {
      void stale.run("printf stale");
    }).toThrow(/PersistentShell closed/);

    // Live handle forwards to the replacement shell.
    const after = await handle!.run("printf after");
    expect(after.stdout).toContain("after");
  });
});
