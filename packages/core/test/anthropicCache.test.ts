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

describe("AnthropicProvider cache TTL", () => {
  afterEach(() => vi.restoreAllMocks());

  async function captureRequest(
    opts: ConstructorParameters<typeof AnthropicProvider>[0],
  ): Promise<{ body: Record<string, unknown>; headers: Record<string, string> }> {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      headers = init.headers as Record<string, string>;
      return sseResponse(MINIMAL_STREAM);
    });
    const p = new AnthropicProvider({ apiKey: "k", ...opts });
    await drain(
      p.stream({
        model: "claude-sonnet-4-5",
        systemPrompt: "you are helpful",
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
          { role: "system", content: [{ type: "text", text: "<runtime_context>\nnow\n</runtime_context>" }] },
          { role: "user", content: [{ type: "text", text: "now please" }] },
        ],
        tools: TOOLS,
      }),
    );
    return { body, headers };
  }

  it("emits no ttl field and no extended beta by default (5m)", async () => {
    const { body, headers } = await captureRequest({});
    const sys = body.system as Array<Record<string, unknown>>;
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(headers["anthropic-beta"]).not.toContain("extended-cache-ttl");
  });

  it("attaches ttl:1h to every breakpoint and sends the extended beta header", async () => {
    const { body, headers } = await captureRequest({ cacheTtl: "1h" });
    // System block.
    const sys = body.system as Array<Record<string, unknown>>;
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Last tool.
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Stable conversation-history breakpoint (on the assistant turn before the
    // volatile runtime_context + current user turn).
    const msgs = body.messages as Array<{ content?: Array<Record<string, unknown>> }>;
    const marked = msgs.flatMap((m) => m.content ?? []).filter((c) => c.cache_control);
    expect(marked.length).toBeGreaterThanOrEqual(1);
    for (const c of marked) expect(c.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Beta header advertises the extended TTL alongside prompt caching.
    expect(headers["anthropic-beta"]).toContain("extended-cache-ttl-2025-04-11");
    expect(headers["anthropic-beta"]).toContain("prompt-caching-2024-07-31");
  });

  it("sends no extended beta header when caching is disabled even with ttl:1h", async () => {
    const { headers } = await captureRequest({ cacheTtl: "1h", enableCaching: false });
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});
