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
