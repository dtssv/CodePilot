// Anthropic extended-thinking tests: budget resolution (pure) + request
// shape + thinking_delta streaming (fetch stubbed, no real API calls).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  resolveThinkingBudget,
} from "../src/providers/anthropic.js";
import type { StreamEvent } from "../src/providers/types.js";

describe("resolveThinkingBudget", () => {
  it("prefers an explicit budget over effort", () => {
    expect(resolveThinkingBudget(8000, "low")).toBe(8000);
  });

  it("maps reasoningEffort to a budget when no explicit budget", () => {
    expect(resolveThinkingBudget(undefined, "low")).toBe(4096);
    expect(resolveThinkingBudget(undefined, "medium")).toBe(10_000);
    expect(resolveThinkingBudget(undefined, "high")).toBe(24_000);
  });

  it("returns 0 (off) when nothing is set", () => {
    expect(resolveThinkingBudget(undefined, undefined)).toBe(0);
  });

  it("treats a 0 / negative explicit budget as off", () => {
    expect(resolveThinkingBudget(0, "high")).toBe(0);
    expect(resolveThinkingBudget(-5, "high")).toBe(0);
  });

  it("floors fractional budgets", () => {
    expect(resolveThinkingBudget(4096.9, undefined)).toBe(4096);
  });
});

/** Build a Response whose body streams the given SSE frames, then closes. */
function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(enc.encode(frames[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Canned stream: one thinking block then one text block. */
const THINKING_THEN_TEXT = [
  frame("message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }),
  frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
  frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } }),
  frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason." } }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } }),
  frame("content_block_stop", { type: "content_block_stop", index: 1 }),
  frame("message_delta", { type: "message_delta", usage: { output_tokens: 5 }, delta: { stop_reason: "end_turn" } }),
  frame("message_stop", { type: "message_stop" }),
];

describe("AnthropicProvider extended thinking", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it("enables thinking + interleaved beta header and streams thinking_delta", async () => {
    let captured: { body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      captured = {
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      };
      return sseResponse(THINKING_THEN_TEXT);
    });

    const p = new AnthropicProvider({ apiKey: "test-key" });
    const events = await collect(
      p.stream({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinkingBudget: 8000,
      }),
    );

    // Request shape
    expect(captured?.body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    // max_tokens grew past the budget so the answer has room.
    expect(captured?.body.max_tokens as number).toBeGreaterThan(8000);
    expect(captured?.headers["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14");

    // Streamed events
    const thinking = events.filter((e) => e.kind === "thinking_delta");
    expect(thinking.map((e) => (e as { text: string }).text).join("")).toBe("Let me reason.");
    const text = events.filter((e) => e.kind === "text_delta");
    expect(text.map((e) => (e as { text: string }).text).join("")).toBe("Answer.");
  });

  it("omits thinking + interleaved header when no budget / effort", async () => {
    let captured: { body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      captured = {
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      };
      return sseResponse([
        frame("message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }),
        frame("message_stop", { type: "message_stop" }),
      ]);
    });

    const p = new AnthropicProvider({ apiKey: "test-key" });
    await collect(
      p.stream({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );

    expect(captured?.body.thinking).toBeUndefined();
    expect(captured?.headers["anthropic-beta"] ?? "").not.toContain("interleaved-thinking");
  });

  it("derives a budget from reasoningEffort alone", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return sseResponse([
        frame("message_start", { type: "message_start", message: { usage: {} } }),
        frame("message_stop", { type: "message_stop" }),
      ]);
    });

    const p = new AnthropicProvider({ apiKey: "test-key" });
    await collect(
      p.stream({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        reasoningEffort: "high",
      }),
    );

    expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 24_000 });
  });
});
