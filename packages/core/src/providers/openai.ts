// OpenAI-compatible Chat Completions API with SSE streaming + tool_calls.
// Works with OpenAI, DeepSeek, 通义千问, vLLM, Ollama, etc. — anything that
// speaks the /v1/chat/completions streaming protocol.

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

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  smallModel?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

export class OpenAIProvider implements ChatProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly baseURL: string;
  readonly defaultModel: string;
  readonly smallModel: string;

  constructor(opts: OpenAIProviderOptions = {}) {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        "OpenAIProvider: missing API key. Pass `apiKey` or set OPENAI_API_KEY."
      );
    }
    this.apiKey = key;
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? "gpt-4o-mini";
    this.smallModel = opts.smallModel ?? "gpt-4o-mini";
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: opts.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: buildOpenAIMessages(opts.systemPrompt, opts.messages),
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map(toOpenAITool);
    }

    // Tolerate baseURL with or without a trailing "/v1" (OpenAI SDK convention
    // includes it; many compatible gateways document the bare host).
    const url = `${this.baseURL}${this.baseURL.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield { kind: "error", message: `OpenAI ${res.status}: ${text.slice(0, 500)}` };
      return;
    }

    const messageId = `chatcmpl_${Math.random().toString(36).slice(2, 10)}`;
    interface ToolAccum {
      id: string;
      name: string;
      args: string;
      emitted: boolean;
    }
    const tools = new Map<number, ToolAccum>();
    let finishReason = "stop";
    let sawDone = false;

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
        if (frame.data === "[DONE]") {
          sawDone = true;
          break;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(frame.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const choices = payload.choices as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const delta = choice.delta as Record<string, unknown> | undefined;
            if (!delta) continue;
            const content = delta.content;
            if (typeof content === "string" && content.length > 0) {
              yield { kind: "text_delta", messageId, text: content };
            }
            const tcDelta = delta.tool_calls as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(tcDelta)) {
              for (const tc of tcDelta) {
                const idx = (tc.index as number) ?? 0;
                let acc = tools.get(idx);
                if (!acc) {
                  acc = {
                    id: (tc.id as string) ?? `call_${idx}_${Math.random().toString(36).slice(2, 8)}`,
                    name: (tc.function as { name?: string } | undefined)?.name ?? "",
                    args: "",
                    emitted: false,
                  };
                  tools.set(idx, acc);
                }
                if (typeof tc.id === "string" && tc.id.length > 0) acc.id = tc.id;
                const fn = tc.function as { name?: string; arguments?: string } | undefined;
                if (fn?.name) acc.name = fn.name;
                if (typeof fn?.arguments === "string") {
                  acc.args += fn.arguments;
                  yield {
                    kind: "tool_input_delta",
                    messageId,
                    toolCallId: acc.id,
                    partialJson: fn.arguments,
                  };
                }
              }
            }
            const fr = choice.finish_reason as string | null | undefined;
            if (fr) finishReason = fr;
          }
        }
        const usage = payload.usage as
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              cached_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            }
          | undefined;
        if (usage) {
          const info: UsageInfo = {
            input: usage.prompt_tokens ?? 0,
            output: usage.completion_tokens ?? 0,
          };
          const cached =
            usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens;
          if (typeof cached === "number") info.cacheRead = cached;
          yield { kind: "usage", usage: info };
        }
      }
    } catch (err) {
      yield { kind: "error", message: (err as Error).message };
      return;
    }

    // Flush any fully-collected tool calls.
    for (const t of [...tools.values()].sort((a, b) => 0)) {
      if (t.emitted) continue;
      let input: unknown = {};
      if (t.args.length > 0) {
        try {
          input = JSON.parse(t.args);
        } catch {
          input = { __raw: t.args };
        }
      }
      yield {
        kind: "tool_call",
        messageId,
        toolCall: { type: "tool_use", id: t.id, name: t.name, input },
      };
      t.emitted = true;
    }
    void sawDone;
    yield { kind: "done", finishReason };
  }
}

function buildOpenAIMessages(
  systemPrompt: string | undefined,
  messages: ProviderMessage[]
): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    if (m.role === "system") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) out.push({ role: "system", content: text });
      continue;
    }
    if (m.role === "user") {
      const parts: unknown[] = [];
      for (const c of m.content as ProviderMessageContent[]) {
        if (c.type === "text") {
          parts.push({ type: "text", text: c.text });
        } else if (c.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${c.mediaType};base64,${c.base64}` },
          });
        }
      }
      if (parts.length === 0) continue;
      if (parts.length === 1 && (parts[0] as { type: string }).type === "text") {
        out.push({ role: "user", content: (parts[0] as { text: string }).text });
      } else {
        out.push({ role: "user", content: parts });
      }
      continue;
    }
    if (m.role === "assistant") {
      const contentParts: string[] = [];
      const toolCalls: unknown[] = [];
      const toolResults: { id: string; content: string; isError?: boolean }[] = [];
      for (const c of m.content as ProviderMessageContent[]) {
        if (c.type === "text") {
          if (c.text.length > 0) contentParts.push(c.text);
        } else if (c.type === "tool_use") {
          toolCalls.push({
            id: c.id,
            type: "function",
            function: {
              name: c.name,
              arguments:
                typeof c.input === "string"
                  ? c.input
                  : JSON.stringify(c.input ?? {}),
            },
          });
        } else if (c.type === "tool_result") {
          toolResults.push({
            id: c.toolCallId,
            content: c.content,
            isError: c.isError,
          });
        }
      }
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = contentParts.length > 0 ? contentParts.join("") : null;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
      // Tool results become their own `tool` messages after the assistant turn.
      for (const r of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: r.id,
          content: r.content,
        });
      }
      continue;
    }
  }
  return out;
}

function toOpenAITool(tool: ProviderToolDef): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
