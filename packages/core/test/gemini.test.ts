// Gemini provider: request shaping + SSE parsing (text / thinking / tool
// calls / usage) + message mapping. fetch is stubbed; no real API calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider, toGeminiContents } from "../src/providers/gemini.js";
import type { ProviderMessage, StreamEvent } from "../src/providers/types.js";

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
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Gemini streams `alt=sse` frames: each `data:` line is one chunk. */
function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("GeminiProvider streaming", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends system instruction + tools and parses text, tool calls and usage", async () => {
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return sseResponse([
        chunk({ candidates: [{ content: { parts: [{ text: "Hello " }] } }] }),
        chunk({ candidates: [{ content: { parts: [{ text: "world" }] } }] }),
        chunk({
          candidates: [
            { content: { parts: [{ functionCall: { name: "do_it", args: { x: 1 } } }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
        }),
      ]);
    });

    const p = new GeminiProvider({ apiKey: "k" });
    const events = await collect(
      p.stream({
        model: "gemini-2.5-flash",
        systemPrompt: "SYS",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "do_it", description: "d", inputSchema: { type: "object", $schema: "x", properties: {} } }],
      }),
    );

    // Request shape
    expect(captured?.url).toContain(":streamGenerateContent");
    expect(captured?.url).toContain("alt=sse");
    expect(captured?.url).toContain("key=k");
    expect(captured?.body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
    // $schema stripped from the tool parameters.
    const tools = captured?.body.tools as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    expect(tools[0]!.functionDeclarations[0]!.parameters).not.toHaveProperty("$schema");

    // Streamed events
    const text = events.filter((e) => e.kind === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("Hello world");
    const calls = events.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(1);
    expect((calls[0] as { toolCall: { name: string; input: unknown } }).toolCall).toMatchObject({ name: "do_it", input: { x: 1 } });
    const usage = events.find((e) => e.kind === "usage") as { usage: { input: number; output: number } } | undefined;
    expect(usage?.usage).toMatchObject({ input: 12, output: 7 });
    const done = events.find((e) => e.kind === "done") as { finishReason: string } | undefined;
    expect(done?.finishReason).toBe("stop");
  });

  it("maps thinking parts to thinking_delta", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        chunk({ candidates: [{ content: { parts: [{ text: "reasoning...", thought: true }] } }] }),
        chunk({ candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] }),
      ]),
    );
    const p = new GeminiProvider({ apiKey: "k" });
    const events = await collect(p.stream({ model: "gemini-2.5-pro", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(events.filter((e) => e.kind === "thinking_delta").map((e) => (e as { text: string }).text).join("")).toBe("reasoning...");
    expect(events.filter((e) => e.kind === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("answer");
  });

  it("surfaces an inline error object", async () => {
    vi.stubGlobal("fetch", async () => sseResponse([chunk({ error: { message: "quota exceeded" } })]));
    const p = new GeminiProvider({ apiKey: "k" });
    const events = await collect(p.stream({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    const err = events.find((e) => e.kind === "error") as { message: string } | undefined;
    expect(err?.message).toBe("quota exceeded");
  });

  it("surfaces a non-200 HTTP error", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 400 }));
    const p = new GeminiProvider({ apiKey: "k" });
    const events = await collect(p.stream({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect((events.find((e) => e.kind === "error") as { message: string }).message).toContain("Gemini 400");
  });

  it("throws without an API key (and no env)", () => {
    const prevG = process.env.GEMINI_API_KEY;
    const prevA = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      expect(() => new GeminiProvider({})).toThrow(/missing API key/);
    } finally {
      if (prevG !== undefined) process.env.GEMINI_API_KEY = prevG;
      if (prevA !== undefined) process.env.GOOGLE_API_KEY = prevA;
    }
  });
});

describe("toGeminiContents mapping", () => {
  it("maps roles, tool_use and tool_result parts", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "result-text" }] },
    ];
    const out = toGeminiContents(messages) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(out[1]!.role).toBe("model");
    expect(out[1]!.parts[0]).toEqual({ functionCall: { name: "fn", args: { a: 1 } } });
    expect(out[2]!.role).toBe("user");
    expect(out[2]!.parts[0]).toMatchObject({ functionResponse: { name: "t1", response: { result: "result-text" } } });
  });

  it("maps images to inlineData and folds stray system text into a user turn", () => {
    const out = toGeminiContents([
      { role: "system", content: [{ type: "text", text: "sys stray" }] },
      { role: "user", content: [{ type: "image", mediaType: "image/png", base64: "AAAA" }] },
    ]) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "sys stray" }] });
    expect(out[1]!.parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
  });
});
