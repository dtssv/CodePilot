// Google Gemini provider — native `generateContent` streaming API.
// No SDK dependency; uses fetch + SSE directly, like the other providers.
//
// Gemini differs from OpenAI/Anthropic in a few ways the mapping handles:
// - roles are "user" / "model" (assistant → model); there is no "system"
//   role — system text goes in a top-level `systemInstruction`.
// - tool calls are `functionCall` parts; tool results are `functionResponse`
//   parts carried on a *user* turn.
// - streaming uses `?alt=sse`; each SSE frame is a GenerateContentResponse
//   chunk with `candidates[].content.parts[]` and a trailing `usageMetadata`.

import { parseSse } from "./sse.js";
import { fetchWithRetry } from "./retry.js";
import type {
  ChatProvider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolDef,
  StreamChatOptions,
  StreamEvent,
} from "./types.js";
import type { UsageInfo } from "../types.js";

export interface GeminiProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  smallModel?: string;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiProvider implements ChatProvider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly baseURL: string;
  readonly defaultModel: string;
  readonly smallModel: string;

  constructor(opts: GeminiProviderOptions = {}) {
    const key = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error(
        "GeminiProvider: missing API key. Pass `apiKey` or set GEMINI_API_KEY / GOOGLE_API_KEY."
      );
    }
    this.apiKey = key;
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? "gemini-2.5-flash";
    this.smallModel = opts.smallModel ?? "gemini-2.5-flash";
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(opts.messages),
    };
    if (opts.systemPrompt) {
      body.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = [{ functionDeclarations: opts.tools.map(toGeminiTool) }];
    }
    const genConfig: Record<string, unknown> = {};
    if (opts.maxTokens) genConfig.maxOutputTokens = opts.maxTokens;
    // Gemini 2.5 exposes a thinking budget; map the shared reasoning knob.
    if (opts.thinkingBudget && opts.thinkingBudget > 0) {
      genConfig.thinkingConfig = { thinkingBudget: Math.floor(opts.thinkingBudget) };
    }
    if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;

    const model = opts.model || this.defaultModel;
    const url =
      `${this.baseURL}/models/${encodeURIComponent(model)}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
      {
        signal: opts.signal,
        onRetry: opts.onRetry
          ? (attempt, delayMs, reason) => opts.onRetry!({ attempt, delayMs, reason })
          : undefined,
      },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield { kind: "error", message: `Gemini ${res.status}: ${text.slice(0, 500)}` };
      return;
    }

    const messageId = `gmni_${Math.random().toString(36).slice(2, 10)}`;
    const usage: UsageInfo = { input: 0, output: 0 };
    let finishReason = "stop";
    let toolIdx = 0;

    try {
      for await (const frame of parseSse(res.body, opts.signal)) {
        if (frame.data === "[DONE]") break;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(frame.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        // Top-level error object (Gemini returns these inline on some failures).
        const err = payload.error as { message?: string } | undefined;
        if (err?.message) {
          yield { kind: "error", message: err.message };
          return;
        }
        const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(candidates)) {
          for (const cand of candidates) {
            const content = cand.content as { parts?: Array<Record<string, unknown>> } | undefined;
            for (const part of content?.parts ?? []) {
              if (typeof part.text === "string" && part.text.length > 0) {
                // Gemini marks reasoning parts with `thought: true`.
                if (part.thought === true) {
                  yield { kind: "thinking_delta", messageId, text: part.text };
                } else {
                  yield { kind: "text_delta", messageId, text: part.text };
                }
              }
              const fc = part.functionCall as { name?: string; args?: unknown } | undefined;
              if (fc?.name) {
                const id = `call_${toolIdx++}_${Math.random().toString(36).slice(2, 8)}`;
                yield {
                  kind: "tool_call",
                  messageId,
                  toolCall: { type: "tool_use", id, name: fc.name, input: fc.args ?? {} },
                };
              }
            }
            const fr = cand.finishReason as string | undefined;
            if (fr) finishReason = mapFinishReason(fr);
          }
        }
        const um = payload.usageMetadata as
          | { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
          | undefined;
        if (um) {
          usage.input = um.promptTokenCount ?? usage.input;
          usage.output = um.candidatesTokenCount ?? usage.output;
          if (typeof um.cachedContentTokenCount === "number") usage.cacheRead = um.cachedContentTokenCount;
        }
      }
    } catch (e) {
      yield { kind: "error", message: (e as Error).message };
      return;
    }

    yield { kind: "usage", usage: { ...usage } };
    yield { kind: "done", finishReason };
  }
}

function mapFinishReason(fr: string): string {
  switch (fr) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return fr.toLowerCase();
  }
}

function toGeminiTool(tool: ProviderToolDef): Record<string, unknown> {
  // Gemini uses OpenAPI-subset schemas; strip JSON-Schema keys it rejects.
  return {
    name: tool.name,
    description: tool.description,
    parameters: sanitizeSchema(tool.inputSchema),
  };
}

/** Gemini's function schema is an OpenAPI 3 subset; drop unsupported keys
 * (`$schema`, `additionalProperties`, `$ref`, etc.) to avoid 400s. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const drop = new Set(["$schema", "additionalProperties", "$ref", "$defs", "definitions"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

/** Map the provider-neutral message list to Gemini `contents`. */
export function toGeminiContents(messages: ProviderMessage[]): unknown[] {
  const out: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      // No system role in `contents`; fold any stray system text into a user
      // turn (the primary system prompt rides in systemInstruction).
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) out.push({ role: "user", parts: [{ text }] });
      continue;
    }
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    const parts: unknown[] = [];
    for (const c of m.content as ProviderMessageContent[]) {
      if (c.type === "text") {
        if (c.text) parts.push({ text: c.text });
      } else if (c.type === "image") {
        parts.push({ inlineData: { mimeType: c.mediaType, data: c.base64 } });
      } else if (c.type === "tool_use") {
        parts.push({ functionCall: { name: c.name, args: c.input ?? {} } });
      } else if (c.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: c.toolCallId,
            response: { result: c.content === "" ? "(no output)" : c.content },
          },
        });
      }
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}
