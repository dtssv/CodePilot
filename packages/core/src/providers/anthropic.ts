// Anthropic Messages API + SSE streaming + prompt caching (cache_control breakpoints).
// No SDK dependency — uses fetch directly.

import { parseSse } from "./sse.js";
import type {
  ChatProvider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolDef,
  StreamChatOptions,
  StreamEvent,
} from "./types.js";
import type { UsageInfo } from "../types.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  smallModel?: string;
  /** Auto-attach cache_control to the last tool / system block. Default true. */
  enableCaching?: boolean;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const BETA_PROMPT_CACHING = "prompt-caching-2024-07-31";

export class AnthropicProvider implements ChatProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly baseURL: string;
  readonly defaultModel: string;
  readonly smallModel: string;
  private readonly enableCaching: boolean;

  constructor(opts: AnthropicProviderOptions = {}) {
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "AnthropicProvider: missing API key. Pass `apiKey` or set ANTHROPIC_API_KEY."
      );
    }
    this.apiKey = key;
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? "claude-sonnet-4-5";
    this.smallModel = opts.smallModel ?? "claude-haiku-4-5";
    this.enableCaching = opts.enableCaching ?? true;
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages.map(toAnthropicMessage),
      max_tokens: opts.maxTokens ?? 4096,
      stream: true,
    };
    if (opts.systemPrompt) {
      if (this.enableCaching) {
        body.system = [
          {
            type: "text",
            text: opts.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ];
      } else {
        body.system = opts.systemPrompt;
      }
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t, i, arr) =>
        toAnthropicTool(t, this.enableCaching && i === arr.length - 1)
      );
    }

    const url = `${this.baseURL}${this.baseURL.endsWith("/v1") ? "" : "/v1"}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": API_VERSION,
    };
    if (this.enableCaching) {
      headers["anthropic-beta"] = BETA_PROMPT_CACHING;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        kind: "error",
        message: `Anthropic ${res.status}: ${text.slice(0, 500)}`,
      };
      return;
    }

    const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
    const accumUsage: UsageInfo = { input: 0, output: 0 };
    const blocks = new Map<number, { type: string; id?: string; name?: string; inputJson: string; text: string }>();

    try {
      for await (const frame of parseSse(res.body, opts.signal)) {
        if (frame.event === "error") {
          let msg = frame.data;
          try {
            const j = JSON.parse(frame.data) as { error?: { message?: string } };
            if (j.error?.message) msg = j.error.message;
          } catch {
            /* keep raw */
          }
          yield { kind: "error", message: msg };
          return;
        }
        if (frame.event !== "message_start" && frame.event !== "content_block_start" && frame.event !== "content_block_delta" && frame.event !== "content_block_stop" && frame.event !== "message_delta" && frame.event !== "message_stop") {
          continue;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(frame.data) as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (payload.type) {
          case "message_start": {
            const m = payload.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
            if (m?.usage) {
              accumUsage.input = m.usage.input_tokens ?? accumUsage.input;
              accumUsage.cacheRead = m.usage.cache_read_input_tokens ?? 0;
              accumUsage.cacheWrite = m.usage.cache_creation_input_tokens ?? 0;
            }
            break;
          }
          case "content_block_start": {
            const idx = payload.index as number;
            const block = payload.content_block as { type: string; id?: string; name?: string; text?: string };
            blocks.set(idx, {
              type: block.type,
              id: block.id,
              name: block.name,
              inputJson: "",
              text: block.text ?? "",
            });
            if (block.type === "text" && block.text) {
              yield { kind: "text_delta", messageId, text: block.text };
            }
            break;
          }
          case "content_block_delta": {
            const idx = payload.index as number;
            const delta = payload.delta as { type: string; text?: string; partial_json?: string };
            const b = blocks.get(idx);
            if (!b) break;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              b.text += delta.text;
              yield { kind: "text_delta", messageId, text: delta.text };
            } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              b.inputJson += delta.partial_json;
              const tcId = b.id ?? `toolu_${idx}`;
              yield {
                kind: "tool_input_delta",
                messageId,
                toolCallId: tcId,
                partialJson: delta.partial_json,
              };
            }
            break;
          }
          case "content_block_stop": {
            const idx = payload.index as number;
            const b = blocks.get(idx);
            if (b && b.type === "tool_use" && b.id && b.name) {
              let input: unknown = {};
              if (b.inputJson.length > 0) {
                try {
                  input = JSON.parse(b.inputJson);
                } catch {
                  input = { __raw: b.inputJson };
                }
              }
              yield {
                kind: "tool_call",
                messageId,
                toolCall: {
                  type: "tool_use",
                  id: b.id,
                  name: b.name,
                  input,
                },
              };
            }
            break;
          }
          case "message_delta": {
            const u = payload.usage as { output_tokens?: number } | undefined;
            if (u?.output_tokens !== undefined) {
              accumUsage.output = u.output_tokens;
            }
            break;
          }
          case "message_stop": {
            yield { kind: "usage", usage: { ...accumUsage } };
            yield { kind: "done", finishReason: "stop" };
            return;
          }
        }
      }
    } catch (err) {
      yield { kind: "error", message: (err as Error).message };
      return;
    }
    yield { kind: "done", finishReason: "stop" };
  }
}

function toAnthropicTool(
  tool: ProviderToolDef,
  attachCacheControl: boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
  if (attachCacheControl) {
    out.cache_control = { type: "ephemeral" };
  }
  return out;
}

function toAnthropicMessage(m: ProviderMessage): Record<string, unknown> {
  if (m.role === "system") {
    // Anthropic takes system as a top-level field; promote text.
    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { role: "user", content: [{ type: "text", text }] };
  }

  const content: unknown[] = [];
  for (const c of m.content as ProviderMessageContent[]) {
    if (c.type === "text") {
      content.push({ type: "text", text: c.text });
    } else if (c.type === "image") {
      content.push({
        type: "image",
        source: { type: "base64", media_type: c.mediaType, data: c.base64 },
      });
    } else if (c.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.input ?? {},
      });
    } else if (c.type === "tool_result") {
      content.push({
        type: "tool_result",
        tool_use_id: c.toolCallId,
        content: c.content,
        is_error: c.isError === true,
      });
    }
  }
  return { role: m.role, content };
}
