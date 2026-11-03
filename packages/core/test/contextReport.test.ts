// contextReport: the per-category context-window breakdown that powers the
// live usage gauge. Verifies the accurate grand total (`sentTokens`), the
// provider-input preference, the current-message split, and that the trigger
// uses the shared compaction geometry.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";

function textProvider(reply: string): ChatProvider {
  return {
    name: "mock",
    defaultModel: "mock",
    smallModel: "mock",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { kind: "text_delta", messageId: "m1", text: reply };
      yield { kind: "usage", usage: { input: 1234, output: 56 } };
      yield { kind: "done", finishReason: "stop" };
    },
  };
}

describe("Session.contextReport", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function makeSession(): Promise<Session> {
    dir = mkdtempSync(join(tmpdir(), "ctx-"));
    const s = new Session(`test_ctx_${Date.now()}`, {
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
        contextWindow: 200_000,
      },
      model: "mock-model",
      provider: textProvider("hello there"),
      pluginRuntimes: false,
    });
    await s.init();
    await s.setTitle("ctx");
    return s;
  }

  it("reports an accurate send total above the event-log total and a valid percent", async () => {
    session = await makeSession();
    await session.prompt("explain the repository layout in detail");
    const r = session.contextReport();

    // Grand total includes the fixed system-prompt / tool-schema cost that
    // rides every turn, so it must be >= the event-log-only total.
    expect(r.sentTokens).toBeGreaterThanOrEqual(r.totalTokens);
    expect(r.sentTokens).toBeGreaterThan(0);
    // Provider reported 1234 input tokens on the mock `done` event.
    expect(r.providerInputTokens).toBe(1234);
    // Percent uses the provider-reported input as ground truth: 1234 / 200000.
    expect(r.usagePercent).toBe(Math.round((1234 / 200_000) * 100));
    expect(r.window).toBe(200_000);
  });

  it("surfaces the current user message as its own category", async () => {
    session = await makeSession();
    await session.prompt("a distinctive user message for the breakdown");
    const r = session.contextReport();
    const last = r.byCategory.find((c) => c.category === "lastMessage");
    expect(last).toBeTruthy();
    expect(last!.tokens).toBeGreaterThan(0);
    // The current message must not double-count: conversation + lastMessage
    // together never exceed the plain event-log total by more than rounding.
    const convo = r.byCategory.find((c) => c.category === "conversation");
    const sum = (convo?.tokens ?? 0) + (last?.tokens ?? 0);
    expect(sum).toBeLessThanOrEqual(r.totalTokens + 5);
  });

  it("derives the trigger from the shared compaction geometry (output-reserved)", async () => {
    session = await makeSession();
    await session.prompt("hi");
    const r = session.contextReport();
    // With a 200k window and the default fraction, the trigger sits at/below
    // the plain window * fraction (geometry additionally reserves output).
    expect(r.triggerThreshold).toBeGreaterThan(0);
    expect(r.triggerThreshold).toBeLessThanOrEqual(
      Math.floor(r.window * r.triggerFraction),
    );
  });
});
