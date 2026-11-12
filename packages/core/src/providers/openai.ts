// OpenAI-compatible Chat Completions API with SSE streaming + tool_calls.
// Works with OpenAI, DeepSeek, 通义千问, vLLM, Ollama, etc. — anything that
// speaks the /v1/chat/completions streaming protocol.

import { parseSse } from "./sse.js";
import { fetchWithRetry, RateLimitAbortedError, parseRateLimitHeaders } from "./retry.js";
import { mergeAdjacentRoles } from "./types.js";
import type {
  ChatProvider,
  FimCompletionOptions,
  FimCompletionResult,
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
  /**
   * API dialect. "openai" (default) targets `/v1/chat/completions` with a
   * Bearer token. "azure" targets Azure OpenAI's
   * `/openai/deployments/{model}/chat/completions?api-version=...` with an
   * `api-key` header; the model id is used as the Azure deployment name.
   * "responses" targets `/v1/responses` (the newer stateful endpoint) with a
   * Bearer token; tool calls and reasoning stream as named SSE events. The
   * streamed output maps onto the same StreamEvent union as the chat path, so
   * the agent loop is dialect-agnostic.
   */
  apiStyle?: "openai" | "azure" | "responses";
  /** Azure `api-version` query param (required when apiStyle === "azure"). */
  azureApiVersion?: string;
 /** Retry config passed through to fetchWithRetry. When omitted, the
 * provider uses more generous defaults than the bare helper: 8 retries
 * with a 2s base delay, so transient 429s from rate-limited gateways
 * (GLM, DeepSeek, Ollama with concurrency=1) don't abort a long run. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
 /** Fail fast once the next retry backoff would exceed this many ms, instead
 * of blocking the agent for tens of seconds per retry under sustained
 * rate-limiting. Default 30s. Set to 0 / undefined to disable. */
  abortOnDelayMs?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_AZURE_API_VERSION = "2024-10-21";

export class OpenAIProvider implements ChatProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly apiStyle: "openai" | "azure" | "responses";
  private readonly azureApiVersion: string;
  readonly defaultModel: string;
  readonly smallModel: string;
  private readonly retryOpts: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    abortOnDelayMs?: number;
  };

  constructor(opts: OpenAIProviderOptions = {}) {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        "OpenAIProvider: missing API key. Pass `apiKey` or set OPENAI_API_KEY."
      );
    }
    this.apiKey = key;
    this.apiStyle = opts.apiStyle ?? "openai";
    this.azureApiVersion = opts.azureApiVersion ?? DEFAULT_AZURE_API_VERSION;
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? "gpt-4o-mini";
    this.smallModel = opts.smallModel ?? "gpt-4o-mini";
    this.retryOpts = {
      maxRetries: opts.maxRetries ?? 8,
      baseDelayMs: opts.baseDelayMs ?? 2000,
      maxDelayMs: opts.maxDelayMs ?? 60_000,
 // Fail fast under sustained 429s: once the next backoff would exceed
 // 30s, stop waiting and surface a recoverable error instead of
 // blocking the agent for a minute per retry.
      abortOnDelayMs: opts.abortOnDelayMs ?? 30_000,
    };
  }

  /** Request URL for the active dialect. Azure routes by deployment name
   * (the model id) and carries the api-version as a query param; "responses"
   * posts to the `/v1/responses` endpoint. */
  private requestURL(model: string): string {
    if (this.apiStyle === "azure") {
      const deployment = encodeURIComponent(model);
      return `${this.baseURL}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(this.azureApiVersion)}`;
    }
    // Tolerate baseURL with or without a trailing "/v1" (OpenAI SDK convention
    // includes it; many compatible gateways document the bare host).
    const v1 = this.baseURL.endsWith("/v1") ? "" : "/v1";
    const path = this.apiStyle === "responses" ? "/responses" : "/chat/completions";
    return `${this.baseURL}${v1}${path}`;
  }

  /** Auth headers for the active dialect. Azure uses `api-key`, OpenAI uses a
   * Bearer token. */
  private authHeaders(): Record<string, string> {
    return this.apiStyle === "azure"
      ? { "api-key": this.apiKey }
      : { authorization: `Bearer ${this.apiKey}` };
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const body =
      this.apiStyle === "responses"
        ? buildResponsesBody(opts)
        : buildChatBody(opts);

 // Tolerate baseURL with or without a trailing "/v1" (OpenAI SDK convention
 // includes it; many compatible gateways document the bare host). Azure
 // routes by deployment name and api-version — see requestURL/authHeaders.
    const url = this.requestURL(opts.model);
    let res: Response;
    try {
      res = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      }, {
        signal: opts.signal,
        maxRetries: this.retryOpts.maxRetries,
        baseDelayMs: this.retryOpts.baseDelayMs,
        maxDelayMs: this.retryOpts.maxDelayMs,
        abortOnDelayMs: this.retryOpts.abortOnDelayMs,
        onRetry: (attempt, delayMs, reason) => {
          if (opts.onRetry) {
            opts.onRetry({ attempt, delayMs, reason });
            return;
          }
 // Surface retries on stderr so the user sees we're waiting, not hung.
          process.stderr.write(`[retry ${attempt}] ${reason} — waiting ${Math.round(delayMs / 1000)}s\n`);
        },
      });
    } catch (err) {
 // Sustained rate-limiting: fetchWithRetry aborted rather than block for
 // a long backoff. Surface as a recoverable error so the agent stops and
 // the host can prompt the user to switch provider/model.
      if (err instanceof RateLimitAbortedError) {
        yield { kind: "error", message: err.message };
        return;
      }
      throw err;
    }
    if (opts.onRateLimit) {
      const rl = parseRateLimitHeaders(res);
      if (rl) opts.onRateLimit(rl);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield { kind: "error", message: `OpenAI ${res.status}: ${text.slice(0, 500)}` };
      return;
    }

    // Both dialects stream onto the same StreamEvent union; the Responses
    // endpoint uses named SSE events, the chat endpoint streams delta chunks.
    if (this.apiStyle === "responses") {
      yield* streamResponses(res.body, opts.signal);
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
            // Reasoning / chain-of-thought stream. Reasoning models on the
            // OpenAI-compatible wire (DeepSeek, GLM, Qwen, …) send their
            // thinking in a SEPARATE field alongside `content` — most commonly
            // `reasoning_content`, some gateways use `reasoning`. Surface it as
            // a thinking_delta so it flows through the same agent→UI→render
            // path as Anthropic/Gemini reasoning; without this the thinking is
            // silently dropped and never shown. Emit before `content` so the
            // thinking leads the visible answer in the transcript.
            const reasoning =
              (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
              (typeof delta.reasoning === "string" && delta.reasoning) ||
              "";
            if (reasoning.length > 0) {
              yield { kind: "thinking_delta", messageId, text: reasoning };
            }
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

 // Flush any fully-collected tool calls. Map preserves insertion order,
 // which matches the tool_call index order the deltas arrived in.
    for (const t of tools.values()) {
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

  /**
   * Native FIM via the OpenAI-compatible `/v1/completions` endpoint with a
   * `suffix` (design G, phase 4). DeepSeek-Coder / Codestral / Qwen-Coder /
   * vLLM / Ollama expose this. ONE non-streaming, FAST-FAIL call (no retry — a
   * late inline completion is worse than none). Azure's deployment routing has
   * no legacy-completions equivalent, so FIM is openai-dialect only; the
   * handler falls back to the chat path for azure.
   */
  async fim(opts: FimCompletionOptions): Promise<FimCompletionResult> {
    if (this.apiStyle === "azure") {
      throw new Error("FIM is not supported on the Azure dialect");
    }
    const url = `${this.baseURL}${this.baseURL.endsWith("/v1") ? "" : "/v1"}/completions`;
    const body: Record<string, unknown> = {
      model: opts.model,
      prompt: opts.prefix,
      suffix: opts.suffix,
      stream: false,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`FIM ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ text?: string }>;
    };
    const text = json.choices?.[0]?.text ?? "";
    return { text };
  }
}

export function buildOpenAIMessages(
  systemPrompt: string | undefined,
  messages: ProviderMessage[]
): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  // Have we emitted anything other than a leading system block yet? Once the
  // conversation proper has started, a later `system` message is a
  // mid-conversation system — which some OpenAI-compatible backends (GLM-5.2
  // via the jdcloud gateway) reject with `invalid_argument`. We demote those
  // to `user` (same as the Anthropic adapter), keeping the content while
  // satisfying "system must lead" backends. A leading system is unaffected.
  let conversationStarted = false;
  for (const m of messages) {
    if (m.role === "system") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) out.push({ role: conversationStarted ? "user" : "system", content: text });
      continue;
    }
    conversationStarted = true;
    if (m.role === "user") {
      const parts: unknown[] = [];
 // Tool results travel as `tool` messages, which must directly follow
 // the assistant turn that issued the calls — so they go out first.
      for (const c of m.content as ProviderMessageContent[]) {
        if (c.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: c.toolCallId,
            content: c.content === "" ? "(no output)" : c.content,
          });
        }
      }
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
  return mergeConsecutiveRoles(out);
}

/** Normalize an OpenAI message's content to an array of content parts so two
 * same-role messages can be concatenated regardless of whether each carried a
 * bare string or a parts array. */
function toParts(content: unknown): unknown[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

/**
 * Collapse adjacent same-role messages for `system` and `user`.
 *
 * Two sources create same-role runs that strict OpenAI-compatible backends —
 * notably GLM-5.2 via the jdcloud gateway — reject with `invalid_argument`:
 *   1. The leading `systemPrompt` plus a harness-injected `<runtime_context>`
 *      system message can land back to back (a sub-agent's first turn, where
 *      history is just the user objective and runtime_context inserts at 0) →
 *      two consecutive `system`.
 *   2. A mid-conversation `system` (runtime_context inserted before the current
 *      turn) is demoted to `user` by `buildOpenAIMessages`, which can place it
 *      right after the opening user message → two consecutive `user`.
 *
 * Merging the content keeps everything the model should see while satisfying
 * backends that require non-repeating roles, mirroring the Anthropic adapter's
 * `mergeConsecutiveRoles`.
 */
function mergeConsecutiveRoles(messages: unknown[]): unknown[] {
  return mergeAdjacentRoles(messages, (prevRaw, curRaw) => {
    const prev = prevRaw as { role?: string; content?: unknown };
    const cur = curRaw as { role?: string; content?: unknown };
    if (prev.role !== cur.role || (cur.role !== "system" && cur.role !== "user")) return false;
    if (cur.role === "system" && typeof prev.content === "string" && typeof cur.content === "string") {
      prev.content = `${prev.content}\n\n${cur.content}`;
      return true;
    }
    if (cur.role === "user") {
      prev.content = [...toParts(prev.content), ...toParts(cur.content)];
      return true;
    }
    return false;
  });
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

/** Build the Chat Completions request body (the default dialect). */
function buildChatBody(opts: StreamChatOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: buildOpenAIMessages(opts.systemPrompt, opts.messages),
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  // Stable cache-affinity key so a session's requests reuse the same cached
  // prefix (OpenAI prompt caching is prefix-automatic; this improves routing).
  if (opts.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map(toOpenAITool);
    // Keep the tool defs in the request (cache-prefix stable) but withdraw the
    // ability to call them when the turn budget says "answer now".
    if (opts.toolChoice === "none") body.tool_choice = "none";
  }
  // Reasoning effort (o-series / reasoning models). Only sent when configured;
  // non-supporting models ignore unknown fields gracefully on most
  // OpenAI-compatible gateways, but we gate on it to avoid surprises.
  if (opts.reasoningEffort) {
    body.reasoning_effort = opts.reasoningEffort;
  }
  // Provider-enforced structured output (OpenAI json_schema). The model is
  // constrained to the supplied schema. Non-supporting gateways 400 on this;
  // callers opt in explicitly via responseFormat.
  if (opts.responseFormat) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: opts.responseFormat.name,
        schema: opts.responseFormat.schema,
        strict: opts.responseFormat.strict ?? true,
      },
    };
  }
  return body;
}

// ---------------------------------------------------------------------------
// Responses API dialect (/v1/responses)
// ---------------------------------------------------------------------------

/** Build the Responses request body. Differs from chat in several field names:
 * the system prompt is top-level `instructions`, the conversation is an `input`
 * item array, tools are flattened, the token cap is `max_output_tokens`, and
 * reasoning is a `{ effort }` object. Maps onto the same inputs so callers are
 * dialect-agnostic. */
function buildResponsesBody(opts: StreamChatOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    stream: true,
    input: buildResponsesInput(opts.messages),
  };
  if (opts.systemPrompt) body.instructions = opts.systemPrompt;
  if (opts.maxTokens) body.max_output_tokens = opts.maxTokens;
  if (opts.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map(toResponsesTool);
    if (opts.toolChoice === "none") body.tool_choice = "none";
  }
  if (opts.reasoningEffort) {
    // Request a reasoning summary so thinking is observable; raw reasoning
    // tokens are not streamed, only the summary is.
    body.reasoning = { effort: opts.reasoningEffort, summary: "auto" };
  }
  if (opts.responseFormat) {
    body.text = {
      format: {
        type: "json_schema",
        name: opts.responseFormat.name,
        schema: opts.responseFormat.schema,
        strict: opts.responseFormat.strict ?? true,
      },
    };
  }
  return body;
}

/** Core tool → Responses function tool (flattened; no nested `function`). */
function toResponsesTool(tool: ProviderToolDef): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

/** Core messages → Responses `input` item array. User/assistant text and
 * images map to input/output content parts; tool calls and their results map
 * to `function_call` / `function_call_output` items. A leading `system`
 * message (beyond the top-level `instructions`) is folded into a user item. */
function buildResponsesInput(messages: ProviderMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) out.push({ role: "user", content: [{ type: "input_text", text }] });
      continue;
    }
    if (msg.role === "user") {
      // Tool results become standalone function_call_output items, emitted
      // before any text/image parts of the same turn.
      for (const c of msg.content) {
        if (c.type === "tool_result") {
          out.push({ type: "function_call_output", call_id: c.toolCallId, output: c.content });
        }
      }
      const parts: unknown[] = [];
      for (const c of msg.content) {
        if (c.type === "text") parts.push({ type: "input_text", text: c.text });
        else if (c.type === "image") {
          parts.push({ type: "input_image", image_url: `data:${c.mediaType};base64,${c.base64}` });
        }
      }
      if (parts.length > 0) out.push({ role: "user", content: parts });
      continue;
    }
    // assistant
    const parts: unknown[] = [];
    const toolCalls: unknown[] = [];
    for (const c of msg.content) {
      if (c.type === "text") parts.push({ type: "output_text", text: c.text });
      else if (c.type === "tool_use") {
        toolCalls.push({
          type: "function_call",
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input ?? {}),
        });
      }
    }
    if (parts.length > 0) out.push({ role: "assistant", content: parts });
    for (const tc of toolCalls) out.push(tc);
  }
  return out;
}

/** Map the Responses named-SSE stream onto the shared StreamEvent union. The
 * Responses endpoint emits `event: response.<kind>` frames (not delta chunks),
 * so this branches on `frame.event`. There is no `[DONE]` sentinel — the stream
 * ends on `response.completed` / `.incomplete` / `.failed` (or when the body
 * closes). */
async function* streamResponses(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  const messageId = `resp_${Math.random().toString(36).slice(2, 10)}`;
  interface ToolAccum { callId: string; name: string; args: string; emitted: boolean; }
  // Keyed by the item_id the deltas carry so several concurrent calls stay
  // separate; insertion order (Map) preserves call order for the final flush.
  const tools = new Map<string, ToolAccum>();
  let finishReason = "stop";

  const flushTool = (acc: ToolAccum): StreamEvent | null => {
    if (acc.emitted) return null;
    acc.emitted = true;
    let input: unknown = {};
    if (acc.args.length > 0) {
      try { input = JSON.parse(acc.args); } catch { input = { __raw: acc.args }; }
    }
    return {
      kind: "tool_call",
      messageId,
      toolCall: { type: "tool_use", id: acc.callId, name: acc.name, input },
    };
  };

  try {
    for await (const frame of parseSse(body, signal)) {
      const event = frame.event;
      let data: Record<string, unknown> = {};
      if (frame.data && frame.data !== "[DONE]") {
        try { data = JSON.parse(frame.data) as Record<string, unknown>; } catch { continue; }
      }

      if (event === "response.output_text.delta") {
        const delta = data.delta;
        if (typeof delta === "string" && delta.length > 0) {
          yield { kind: "text_delta", messageId, text: delta };
        }
      } else if (
        event === "response.reasoning_summary_text.delta" ||
        event === "response.reasoning_text.delta"
      ) {
        const delta = data.delta;
        if (typeof delta === "string" && delta.length > 0) {
          yield { kind: "thinking_delta", messageId, text: delta };
        }
      } else if (event === "response.output_item.added") {
        const item = data.item as Record<string, unknown> | undefined;
        if (item && item.type === "function_call") {
          const itemId = (data.item_id as string) ?? (item.id as string) ?? "";
          tools.set(itemId, {
            callId: (item.call_id as string) ?? itemId,
            name: (item.name as string) ?? "",
            args: typeof item.arguments === "string" ? (item.arguments as string) : "",
            emitted: false,
          });
        }
      } else if (event === "response.function_call_arguments.delta") {
        const itemId = (data.item_id as string) ?? "";
        const delta = data.delta;
        const acc = tools.get(itemId);
        if (acc && typeof delta === "string") {
          acc.args += delta;
          yield { kind: "tool_input_delta", messageId, toolCallId: acc.callId, partialJson: delta };
        }
      } else if (event === "response.output_item.done") {
        const item = data.item as Record<string, unknown> | undefined;
        if (item && item.type === "function_call") {
          const itemId = (data.item_id as string) ?? (item.id as string) ?? "";
          let acc = tools.get(itemId);
          if (!acc) {
            acc = {
              callId: (item.call_id as string) ?? itemId,
              name: (item.name as string) ?? "",
              args: typeof item.arguments === "string" ? (item.arguments as string) : "",
              emitted: false,
            };
            tools.set(itemId, acc);
          } else if (typeof item.arguments === "string" && item.arguments.length >= acc.args.length) {
            acc.args = item.arguments;
          }
          const ev = flushTool(acc);
          if (ev) yield ev;
        }
      } else if (event === "response.completed" || event === "response.incomplete") {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = response?.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              input_tokens_details?: { cached_tokens?: number };
            }
          | undefined;
        if (usage) {
          const info: UsageInfo = {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          };
          const cached = usage.input_tokens_details?.cached_tokens;
          if (typeof cached === "number") info.cacheRead = cached;
          yield { kind: "usage", usage: info };
        }
        if (event === "response.incomplete") {
          const reason = (response?.incomplete_details as { reason?: string } | undefined)?.reason;
          finishReason = reason ?? "length";
        }
      } else if (event === "response.failed" || event === "response.error" || event === "error") {
        const response = data.response as Record<string, unknown> | undefined;
        const err =
          (response?.error as { message?: string } | undefined)?.message ??
          (data.error as { message?: string } | undefined)?.message ??
          (typeof data.message === "string" ? (data.message as string) : "") ??
          frame.data;
        yield { kind: "error", message: err || "Responses stream error" };
        return;
      }
    }
  } catch (err) {
    yield { kind: "error", message: (err as Error).message };
    return;
  }

  // Flush any tool call that never got an explicit done event.
  for (const acc of tools.values()) {
    const ev = flushTool(acc);
    if (ev) yield ev;
  }
  yield { kind: "done", finishReason };
}
