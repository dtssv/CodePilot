import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

const instantProvider: ChatProvider = {
  name: "mock",
  defaultModel: "mock",
  smallModel: "mock",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { kind: "text_delta", messageId: "m", text: "ok" };
    yield { kind: "done", finishReason: "stop" };
  },
};

describe("follow-up queue", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function makeSession() {
    dir = mkdtempSync(join(tmpdir(), "fu-"));
    session = new Session(`test_fu_${Date.now()}`, {
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

  it("prompt returns queued when already busy", async () => {
    const s = await makeSession();
    const events: Event[] = [];
    s.subscribe((e) => events.push(e));
    (s as unknown as { cancelController: AbortController | null }).cancelController =
      new AbortController();
    expect(s.isBusy()).toBe(true);
    expect(await s.prompt("follow")).toBe("queued");
    expect(s.listFollowUps().map((x) => x.text)).toEqual(["follow"]);
    expect(events.some((e) => e.type === "followup" && e.action === "queued")).toBe(true);
    (s as unknown as { cancelController: AbortController | null }).cancelController = null;
  });

  it("removeFollowUp and clearFollowUps update the queue", async () => {
    const s = await makeSession();
    const a = s.enqueueFollowUp({ text: "a" });
    s.enqueueFollowUp({ text: "b" });
    expect(s.listFollowUps()).toHaveLength(2);
    expect(s.removeFollowUp(a.id)).toBe(true);
    expect(s.listFollowUps().map((x) => x.text)).toEqual(["b"]);
    s.clearFollowUps();
    expect(s.listFollowUps()).toEqual([]);
  });
});
