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

describe("Session.contextReport hybrid estimate", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds a trailing estimate for events appended after the measured anchor", async () => {
    dir = mkdtempSync(join(tmpdir(), "ctxh-"));
    // Turn 1 anchors the estimate at a measured 10,000 input tokens. Turn 2
    // emits a large assistant reply but NO usage event — so the anchor stays at
    // 10,000 while turn 2's messages are trailing. The gauge must reflect the
    // trailing cost immediately instead of waiting for the next measurement.
    const bigReply = "lorem ipsum ".repeat(1500); // ~4.5k tokens of trailing text
    let turn = 0;
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock-model",
      smallModel: "mock-model",
      async *stream(): AsyncIterable<StreamEvent> {
        turn += 1;
        if (turn === 1) {
          yield { kind: "text_delta", messageId: "m1", text: "ok" };
          yield { kind: "usage", usage: { input: 10_000, output: 5 } };
          yield { kind: "done", finishReason: "stop" };
        } else {
          // No usage event → the anchor is not refreshed; this reply trails it.
          yield { kind: "text_delta", messageId: "m2", text: bigReply };
          yield { kind: "done", finishReason: "stop" };
        }
      },
    };
    session = new Session(`ctxh_${Date.now()}`, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        stopVerify: "off",
        contextWindow: 40_000,
      },
      model: "mock-model",
      provider,
      pluginRuntimes: false,
    });
    await session.init();
    await session.setTitle("ctxh");

    await session.prompt("hi");
    const afterAnchor = session.contextReport();
    // Right after the measured turn the effective total equals the anchor.
    expect(afterAnchor.providerInputTokens).toBe(10_000);
    const anchorPercent = afterAnchor.usagePercent;

    await session.prompt("say a lot");
    const afterTool = session.contextReport();
    // The anchor is unchanged (no new usage), but the large trailing reply
    // pushes the effective estimate above the bare 10k anchor and the gauge
    // percentage up with it.
    expect(afterTool.providerInputTokens).toBe(10_000);
    expect(afterTool.usagePercent).toBeGreaterThan(anchorPercent);
    // Sanity: the effective estimate stays well under a blind full re-estimate
    // that would also recount the 10k prefix from scratch (it reuses the anchor).
    expect(afterTool.usagePercent).toBeLessThan(
      Math.round(((10_000 + afterTool.sentTokens) / 40_000) * 100),
    );
  });

  it("clears the anchor on a model switch", async () => {
    dir = mkdtempSync(join(tmpdir(), "ctxm-"));
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock-model",
      smallModel: "mock-model",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { kind: "text_delta", messageId: "m1", text: "ok" };
        yield { kind: "usage", usage: { input: 10_000, output: 5 } };
        yield { kind: "done", finishReason: "stop" };
      },
    };
    session = new Session(`ctxm_${Date.now()}`, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        stopVerify: "off",
        contextWindow: 200_000,
      },
      model: "mock-model",
      provider,
      pluginRuntimes: false,
    });
    await session.init();
    await session.setTitle("ctxm");
    await session.prompt("hi");
    expect(session.contextReport().providerInputTokens).toBe(10_000);

    // A different model re-bills the whole prompt, so the measured anchor must
    // drop and the estimate fall back to the event-log estimate.
    await session.setModel("mock-model-2");
    const after = session.contextReport();
    expect(after.providerInputTokens).toBe(0);
    // Effective total now reflects only the transcript estimate, not the old
    // 10k anchor.
    expect(after.usagePercent).toBeLessThan(
      Math.round((10_000 / 200_000) * 100) + 1,
    );
  });
});

describe("Session.preciseContextCount", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function provider(withCount: boolean): ChatProvider {
    const p: ChatProvider = {
      name: "mock",
      defaultModel: "mock-model",
      smallModel: "mock-model",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { kind: "text_delta", messageId: "m1", text: "ok" };
        yield { kind: "usage", usage: { input: 1000, output: 5 } };
        yield { kind: "done", finishReason: "stop" };
      },
    };
    if (withCount) {
      p.countTokens = async () => ({ inputTokens: 7777 });
    }
    return p;
  }

  async function makeSession(opts: {
    preciseCount?: "off" | "on-demand";
    withCount: boolean;
  }): Promise<Session> {
    dir = mkdtempSync(join(tmpdir(), "ctxp-"));
    const s = new Session(`ctxp_${Date.now()}`, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        stopVerify: "off",
        contextWindow: 200_000,
        context: opts.preciseCount ? { preciseCount: opts.preciseCount } : undefined,
      },
      model: "mock-model",
      provider: provider(opts.withCount),
      pluginRuntimes: false,
    });
    await s.init();
    await s.setTitle("ctxp");
    await s.prompt("hi");
    return s;
  }

  it("returns null when precise counting is off (default)", async () => {
    session = await makeSession({ withCount: true });
    expect(await session.preciseContextCount()).toBeNull();
  });

  it("returns null when the provider has no count API even on-demand", async () => {
    session = await makeSession({ preciseCount: "on-demand", withCount: false });
    expect(await session.preciseContextCount()).toBeNull();
  });

  it("returns the provider count when on-demand and supported", async () => {
    session = await makeSession({ preciseCount: "on-demand", withCount: true });
    expect(await session.preciseContextCount()).toEqual({ inputTokens: 7777 });
  });
});
