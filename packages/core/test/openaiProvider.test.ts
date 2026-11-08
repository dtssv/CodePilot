// OpenAI provider request-shape tests (fetch stubbed, no real API calls).

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
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
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const DONE = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"];

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("OpenAIProvider request shape", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends prompt_cache_key when provided (cache affinity)", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return sseResponse(DONE);
    });
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    await collect(
      p.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        promptCacheKey: "ses_abc123",
      }),
    );
    expect(body?.prompt_cache_key).toBe("ses_abc123");
  });

  it("omits prompt_cache_key when not provided", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return sseResponse(DONE);
    });
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    await collect(
      p.stream({ model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(body && "prompt_cache_key" in body).toBe(false);
  });

  it("uses the OpenAI dialect URL + Bearer auth by default", async () => {
    let url: string | undefined;
    let headers: Record<string, string> | undefined;
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return sseResponse(DONE);
    });
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    await collect(
      p.stream({ model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(headers?.authorization).toBe("Bearer k");
    expect(headers && "api-key" in headers).toBe(false);
  });

  it("emits response_format json_schema when responseFormat is set", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return sseResponse(DONE);
    });
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    await collect(
      p.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        responseFormat: {
          name: "answer",
          schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        },
      }),
    );
    const rf = body?.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("answer");
    expect(rf.json_schema.strict).toBe(true); // defaults to true
    expect(rf.json_schema.schema).toMatchObject({ type: "object" });
  });

  it("omits response_format when responseFormat is not set", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return sseResponse(DONE);
    });
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    await collect(
      p.stream({ model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(body && "response_format" in body).toBe(false);
  });
});

describe("OpenAIProvider.fim (native fill-in-the-middle)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs prompt+suffix to /v1/completions and returns choices[0].text", async () => {
    let url: string | undefined;
    let body: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(init.body as string);
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ text: "return 1;" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    const r = await p.fim({ model: "deepseek-coder", prefix: "function f() {\n  ", suffix: "\n}", maxTokens: 64 });
    expect(url).toBe("https://example.com/v1/completions");
    expect(body?.prompt).toBe("function f() {\n  ");
    expect(body?.suffix).toBe("\n}");
    expect(body?.stream).toBe(false);
    expect(body?.max_tokens).toBe(64);
    expect(headers?.authorization).toBe("Bearer k");
    expect(r.text).toBe("return 1;");
  });

  it("appends /v1 when baseURL omits it", async () => {
    let url: string | undefined;
    vi.stubGlobal("fetch", async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ choices: [{ text: "x" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com" });
    await p.fim({ model: "m", prefix: "a", suffix: "b" });
    expect(url).toBe("https://example.com/v1/completions");
  });

  it("returns empty text when the response has no choices", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    const r = await p.fim({ model: "m", prefix: "a", suffix: "b" });
    expect(r.text).toBe("");
  });

  it("throws on a non-OK response (caller fast-fails)", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("bad model", { status: 400 }),
    );
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    await expect(p.fim({ model: "m", prefix: "a", suffix: "b" })).rejects.toThrow(/FIM 400/);
  });

  it("rejects FIM on the Azure dialect", async () => {
    const p = new OpenAIProvider({
      apiKey: "k",
      baseURL: "https://example.openai.azure.com",
      apiStyle: "azure",
      azureApiVersion: "2024-10-21",
    });
    await expect(p.fim({ model: "m", prefix: "a", suffix: "b" })).rejects.toThrow(/Azure/);
  });
});

describe("OpenAIProvider reasoning stream", () => {
  afterEach(() => vi.restoreAllMocks());

  it("surfaces delta.reasoning_content as thinking_delta (DeepSeek/GLM/Qwen)", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"let me "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"the answer"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    const events = await collect(
      p.stream({ model: "glm-5.2", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    const thinking = events.filter((e) => e.kind === "thinking_delta");
    const text = events.filter((e) => e.kind === "text_delta");
    expect(thinking.map((e) => (e as { text: string }).text)).toEqual(["let me ", "think"]);
    expect(text.map((e) => (e as { text: string }).text)).toEqual(["the answer"]);
    // Thinking must lead the visible answer in stream order.
    expect(events.findIndex((e) => e.kind === "thinking_delta")).toBeLessThan(
      events.findIndex((e) => e.kind === "text_delta"),
    );
  });

  it("also accepts the alternate `reasoning` field name", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    const events = await collect(
      p.stream({ model: "deepseek-reasoner", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(events.filter((e) => e.kind === "thinking_delta").map((e) => (e as { text: string }).text)).toEqual(["hmm"]);
  });

  it("does not emit thinking_delta for ordinary content-only responses", async () => {
    vi.stubGlobal("fetch", async () => sseResponse(DONE));
    const p = new OpenAIProvider({ apiKey: "k", baseURL: "https://example.com/v1" });
    const events = await collect(
      p.stream({ model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(events.some((e) => e.kind === "thinking_delta")).toBe(false);
  });
});

describe("OpenAIProvider Azure dialect", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes by deployment + api-version and uses the api-key header", async () => {
    let url: string | undefined;
    let headers: Record<string, string> | undefined;
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return sseResponse(DONE);
    });
    const p = new OpenAIProvider({
      apiStyle: "azure",
      azureApiVersion: "2024-10-21",
      apiKey: "secret",
      baseURL: "https://my-res.openai.azure.com",
      defaultModel: "my-gpt4o-deploy",
    });
    await collect(
      p.stream({
        model: "my-gpt4o-deploy",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );
    expect(url).toBe(
      "https://my-res.openai.azure.com/openai/deployments/my-gpt4o-deploy/chat/completions?api-version=2024-10-21",
    );
    // Azure authenticates with an api-key header, not a Bearer token.
    expect(headers?.["api-key"]).toBe("secret");
    expect(headers && "authorization" in headers).toBe(false);
  });

  it("falls back to a default api-version when none is given", async () => {
    let url: string | undefined;
    vi.stubGlobal("fetch", async (u: string) => {
      url = u;
      return sseResponse(DONE);
    });
    const p = new OpenAIProvider({
      apiStyle: "azure",
      apiKey: "secret",
      baseURL: "https://my-res.openai.azure.com/",
      defaultModel: "d",
    });
    await collect(
      p.stream({ model: "d", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(url).toMatch(/\?api-version=\d{4}-\d{2}-\d{2}$/);
    // Trailing slash on baseURL must not double up.
    expect(url).not.toContain(".com//openai");
  });
});
