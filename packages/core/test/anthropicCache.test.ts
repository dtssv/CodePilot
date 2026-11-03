// Anthropic prompt-cache breakpoint tests (fetch stubbed, no real API calls).
//
// CodePilot places up to 3 cache_control breakpoints: system block, last tool
// definition, and the stable conversation-history prefix. The tool breakpoint
// is gated by `cacheControlOnTools` so a compat gateway that rejects
// cache_control inside a tool definition can drop ONLY that one while keeping
// system + history caching.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { StreamEvent } from "../src/providers/types.js";

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

const MINIMAL_STREAM = [
  frame("message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }),
  frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
  frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  frame("message_delta", { type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } }),
  frame("message_stop", { type: "message_stop" }),
];

async function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of stream) {
    /* drain */
  }
}

const TOOLS = [
  { name: "a", description: "tool a", inputSchema: { type: "object" } },
  { name: "b", description: "tool b", inputSchema: { type: "object" } },
];

describe("AnthropicProvider tool cache breakpoint", () => {
  afterEach(() => vi.restoreAllMocks());

  async function capture(
    opts: ConstructorParameters<typeof AnthropicProvider>[0],
  ): Promise<Array<Record<string, unknown>>> {
    let tools: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      tools = body.tools as Array<Record<string, unknown>>;
      return sseResponse(MINIMAL_STREAM);
    });
    const p = new AnthropicProvider({ apiKey: "k", ...opts });
    await drain(
      p.stream({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: TOOLS,
      }),
    );
    return tools;
  }

  it("attaches cache_control to the last tool by default", async () => {
    const tools = await capture({});
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("drops the tool breakpoint when cacheControlOnTools is false", async () => {
    const tools = await capture({ cacheControlOnTools: false });
    // No tool carries cache_control — but system/history caching is unaffected.
    for (const t of tools) expect(t.cache_control).toBeUndefined();
  });

  it("drops the tool breakpoint when caching is disabled entirely", async () => {
    const tools = await capture({ enableCaching: false });
    for (const t of tools) expect(t.cache_control).toBeUndefined();
  });
});
