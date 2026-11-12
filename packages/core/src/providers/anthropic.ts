// Anthropic Messages API + SSE streaming + prompt caching (cache_control breakpoints).
// No SDK dependency — uses fetch directly.

import { parseSse } from "./sse.js";
import { fetchWithRetry, parseRateLimitHeaders } from "./retry.js";
import { mergeAdjacentRoles } from "./types.js";
import type {
  ChatProvider,
  CountTokensOptions,
  CountTokensResult,
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
 /**
  * Whether the endpoint honours `cache_control` on *tool definitions*. The
  * real Anthropic API does (default true). Some Anthropic-compatible gateways
  * reject a `cache_control` field inside a tool definition even though they
  * accept it on system/message blocks. Set false for such an endpoint to drop
  * ONLY the tool breakpoint — system and conversation-history caching stay on.
  * This is a capability dimension of `enableCaching`, not a separate toggle:
  * it has no effect when caching is disabled.
  */
  cacheControlOnTools?: boolean;
  /**
   * Lifetime for the `cache_control` breakpoints. "5m" (default) uses
   * Anthropic's standard ephemeral TTL and emits no `ttl` field (back-compat).
   * "1h" asks for the extended one-hour TTL — it adds `ttl: "1h"` to every
   * breakpoint and sends the extended-cache-ttl beta header. Endpoints that do
   * not support the extended TTL ignore the field and fall back to 5m; no
   * separate eligibility probe is needed.
   */
  cacheTtl?: "5m" | "1h";
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const BETA_PROMPT_CACHING = "prompt-caching-2024-07-31";
// Opt-in one-hour cache lifetime. Sent only when cacheTtl is "1h"; endpoints
// that do not recognise it ignore the `ttl` field and keep the 5m default.
const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-2025-04-11";
// Lets the model think between tool calls (not just before the first
// response). Required for extended thinking to interleave with tool use.
const BETA_INTERLEAVED_THINKING = "interleaved-thinking-2025-05-14";

// Map the shared `reasoningEffort` knob onto an Anthropic thinking budget
// (in tokens) so callers don't have to configure two different things.
// Explicit `thinkingBudget` always wins over this.
const EFFORT_BUDGET: Record<"low" | "medium" | "high", number> = {
  low: 4096,
  medium: 10_000,
  high: 24_000,
};

/**
 * Resolve the effective thinking budget from explicit budget / effort.
 * Returns 0 when thinking should stay off.
 */
export function resolveThinkingBudget(
  thinkingBudget: number | undefined,
  reasoningEffort: "low" | "medium" | "high" | undefined
): number {
  if (typeof thinkingBudget === "number") {
    return thinkingBudget > 0 ? Math.floor(thinkingBudget) : 0;
  }
  if (reasoningEffort) return EFFORT_BUDGET[reasoningEffort];
  return 0;
}

// Anthropic requires max_tokens > thinking.budget_tokens, with the budget
// itself being at least 1024. We keep a margin so the model still has room
// to produce a visible answer / tool calls after thinking.
const MIN_THINKING_BUDGET = 1024;
const ANSWER_HEADROOM = 4096;

export class AnthropicProvider implements ChatProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly baseURL: string;
  readonly defaultModel: string;
  readonly smallModel: string;
  private readonly enableCaching: boolean;
  private readonly cacheControlOnTools: boolean;
  /** The `cache_control` object attached at every breakpoint. Carries `ttl:
   * "1h"` only when the extended TTL is configured; otherwise the bare
   * ephemeral form (API default 5m). */
  private readonly cacheControl: { type: "ephemeral"; ttl?: "1h" };
  private readonly extendedTtl: boolean;

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
    this.cacheControlOnTools = opts.cacheControlOnTools ?? true;
    this.extendedTtl = opts.cacheTtl === "1h";
    this.cacheControl = this.extendedTtl
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const budget = resolveThinkingBudget(opts.thinkingBudget, opts.reasoningEffort);
    const thinkingOn = budget >= MIN_THINKING_BUDGET;
    // Thinking requires max_tokens strictly greater than the budget; grow it
    // if the caller's limit (or our 4096 default) would leave no answer room.
    const baseMaxTokens = opts.maxTokens ?? 4096;
    const maxTokens = thinkingOn
      ? Math.max(baseMaxTokens, budget + ANSWER_HEADROOM)
      : baseMaxTokens;

    // Budgeted prompt-cache breakpoint placement: Anthropic allows up to 4
    // `cache_control` breakpoints. Fill them by priority — system block, last
    // tool, then the stable conversation-history tail — counting what the first
    // two use so history gets the remainder (never exceeding the cap, never
    // marking the volatile runtime_context / current turn). Breakpoint count is
    // reported as usage telemetry below.
    const BREAKPOINT_CAP = 4;
    const systemCached = !!opts.systemPrompt && this.enableCaching;
    const toolCached =
      !!opts.tools && opts.tools.length > 0 && this.enableCaching && this.cacheControlOnTools;
    const fixedBreakpoints = (systemCached ? 1 : 0) + (toolCached ? 1 : 0);
    const historyBudget = Math.max(0, BREAKPOINT_CAP - fixedBreakpoints);

    const anthropicMessages = mergeConsecutiveRoles(opts.messages.map(toAnthropicMessage));
    const historyBreakpoints = markConversationCache(
      anthropicMessages,
      this.enableCaching,
      this.cacheControl,
      historyBudget,
    );
    const cacheBreakpoints = fixedBreakpoints + historyBreakpoints;

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
    };
    if (thinkingOn) {
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
    if (opts.systemPrompt) {
      if (this.enableCaching) {
        body.system = [
          {
            type: "text",
            text: opts.systemPrompt,
            cache_control: this.cacheControl,
          },
        ];
      } else {
        body.system = opts.systemPrompt;
      }
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t, i, arr) =>
        toAnthropicTool(
          t,
          this.enableCaching && this.cacheControlOnTools && i === arr.length - 1,
          this.cacheControl,
        )
      );
      // Keep tool defs in the request (cache-prefix stable) but forbid calling
      // them when the turn budget says "answer now". Anthropic spells this
      // `tool_choice: { type: "none" }`.
      if (opts.toolChoice === "none") body.tool_choice = { type: "none" };
    }

    const url = `${this.baseURL}${this.baseURL.endsWith("/v1") ? "" : "/v1"}/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": API_VERSION,
    };
    if (this.enableCaching) {
      headers["anthropic-beta"] = BETA_PROMPT_CACHING;
      if (this.extendedTtl) {
        headers["anthropic-beta"] += `,${BETA_EXTENDED_CACHE_TTL}`;
      }
    }
    if (thinkingOn) {
      // Append so we keep prompt-caching when both are active.
      headers["anthropic-beta"] = headers["anthropic-beta"]
        ? `${headers["anthropic-beta"]},${BETA_INTERLEAVED_THINKING}`
        : BETA_INTERLEAVED_THINKING;
    }

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    }, {
      signal: opts.signal,
      onRetry: opts.onRetry
        ? (attempt, delayMs, reason) => opts.onRetry!({ attempt, delayMs, reason })
        : undefined,
    });
    if (opts.onRateLimit) {
      const rl = parseRateLimitHeaders(res);
      if (rl) opts.onRateLimit(rl);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        kind: "error",
        message: `Anthropic ${res.status}: ${text.slice(0, 500)}`,
      };
      return;
    }

    const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
    const accumUsage: UsageInfo = { input: 0, output: 0, cacheBreakpoints };
    let stopReason = "stop";
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
            const delta = payload.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
            const b = blocks.get(idx);
            if (!b) break;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              b.text += delta.text;
              yield { kind: "text_delta", messageId, text: delta.text };
            } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
              yield { kind: "thinking_delta", messageId, text: delta.thinking };
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
            const sr = (payload.delta as { stop_reason?: string } | undefined)?.stop_reason;
            if (sr) stopReason = sr;
            break;
          }
          case "message_stop": {
            yield { kind: "usage", usage: { ...accumUsage } };
            yield { kind: "done", finishReason: stopReason };
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

  /**
   * Exact prompt token count via Anthropic's `/v1/messages/count_tokens`. A
   * single non-streaming request; used only on explicit demand to show an
   * accurate `/context` gauge. Never attaches cache_control (counting is
   * cache-agnostic) and never drives compaction.
   */
  async countTokens(opts: CountTokensOptions): Promise<CountTokensResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: mergeConsecutiveRoles(opts.messages.map(toAnthropicMessage)),
    };
    if (opts.systemPrompt) body.system = opts.systemPrompt;
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    const url = `${this.baseURL}${this.baseURL.endsWith("/v1") ? "" : "/v1"}/messages/count_tokens`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
      { signal: opts.signal },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`count_tokens ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { input_tokens?: number };
    return { inputTokens: json.input_tokens ?? 0 };
  }
}

function toAnthropicTool(
  tool: ProviderToolDef,
  attachCacheControl: boolean,
  cacheControl: { type: "ephemeral"; ttl?: "1h" },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
  if (attachCacheControl) {
    out.cache_control = cacheControl;
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

/**
 * Place prompt-cache breakpoints on the conversation-history prefix so
 * multi-turn chats reuse the cached message history — not just system + tools.
 * Anthropic allows up to 4 `cache_control` breakpoints per request; this fills
 * whatever the system + tool breakpoints left unused with breakpoints on the
 * newest STABLE messages (walking backward from the current turn).
 *
 * Breakpoints go on the last cacheable block of each chosen message, skipping
 * the per-turn volatile tail — the `<runtime_context>` message and the current
 * user turn — which change every turn and must stay outside the cached prefix.
 * Marking the last few stable messages (not just one) means a change deep in
 * history only invalidates from its breakpoint forward, keeping earlier spans
 * cached. Returns the number of history breakpoints actually placed.
 */
function markConversationCache(
  messages: Array<Record<string, unknown>>,
  enabled: boolean,
  cacheControl: { type: "ephemeral"; ttl?: "1h" },
  budget: number,
): number {
  if (!enabled || budget <= 0 || messages.length < 2) return 0;
  const isVolatile = (m: Record<string, unknown>): boolean => {
    const content = m.content as Array<{ type?: string; text?: string }> | undefined;
    return Array.isArray(content) && content.some((c) => c.type === "text" && c.text?.includes("<runtime_context>"));
  };
  const markOne = (m: Record<string, unknown>): boolean => {
    const content = m.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content) || content.length === 0) return false;
    const last = content[content.length - 1]!;
    // Only text/tool_result/tool_use blocks accept cache_control.
    if (last.type === "text" || last.type === "tool_result" || last.type === "tool_use") {
      if (last.cache_control) return false; // already marked — do not double-spend
      content[content.length - 1] = { ...last, cache_control: cacheControl };
      return true;
    }
    return false;
  };
  // Walk backward from the current turn (the final message), skipping the
  // volatile tail, and mark up to `budget` stable messages.
  let placed = 0;
  let idx = messages.length - 1; // skip the current turn
  idx--;
  while (idx >= 0 && placed < budget) {
    const m = messages[idx]!;
    if (!isVolatile(m) && markOne(m)) placed += 1;
    idx--;
  }
  return placed;
}

/**
 * Anthropic requires message roles to alternate user/assistant and forbids two
 * consecutive messages with the same role. Harness-injected `system`-role
 * messages are promoted to `user` above, which can place two user messages in a
 * row (e.g. the real user turn followed by the runtime-context message). Merge
 * adjacent same-role messages by concatenating their content blocks so the
 * sequence stays valid without losing the separate-message intent upstream.
 */
function mergeConsecutiveRoles(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return mergeAdjacentRoles(messages, (prev, cur) => {
    if (prev.role !== cur.role || !Array.isArray(prev.content) || !Array.isArray(cur.content)) {
      return false;
    }
    prev.content = [...(prev.content as unknown[]), ...(cur.content as unknown[])];
    return true;
  });
}
