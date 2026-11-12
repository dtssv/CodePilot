// ChatProvider abstraction. All providers must emit the same StreamEvent shape
// so that the agent loop can stay provider-agnostic.

import type {
  ContentBlock,
  ImageAttachment,
  ToolUseBlock,
  UsageInfo,
} from "../types.js";

/** Description of a single tool exposed to a provider. */
export interface ProviderToolDef {
  name: string;
  description: string;
 /** Pre-serialised JSON Schema (object). */
  inputSchema: Record<string, unknown>;
}

export interface ProviderMessage {
  role: "user" | "assistant" | "system";
  content: ProviderMessageContent[];
}

export type ProviderMessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "image"; mediaType: string; base64: string };

/** Internal accumulator the agent loop consumes while a model is streaming. */
export interface AssistantAccumulator {
  messageId: string;
  text: string;
  toolCalls: ToolUseBlock[];
  usage: UsageInfo;
 /** True when the stream has completed (no further deltas). */
  done: boolean;
}

export interface StreamChatOptions {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  systemPrompt?: string;
 /** Cache-control breakpoint hint (Anthropic). */
  cacheControl?: boolean;
 /** Stable cache-affinity key (OpenAI `prompt_cache_key`). Routes requests
 * from the same session to the same cached prefix. Providers without an
 * explicit knob ignore it. */
  promptCacheKey?: string;
  signal?: AbortSignal;
  maxTokens?: number;
 /** Model reasoning effort. Providers that support it
 * (OpenAI o-series, DeepSeek) pass this through; others ignore it. */
  reasoningEffort?: "low" | "medium" | "high";
 /** Extended-thinking token budget (Anthropic). When > 0 the Anthropic
  * provider enables a `thinking` block with this budget and streams the
  * model's reasoning as `thinking_delta` events. Other providers ignore it.
  * Callers that only set `reasoningEffort` get a sensible budget derived
  * from it (see `anthropic.ts`); setting this explicitly takes precedence. */
  thinkingBudget?: number;
 /**
  * Provider-enforced structured output. OpenAI dialect emits
  * `response_format: { type: "json_schema", ... }`; others ignore it.
  * Some models reject it combined with tool-calling (single-shot only).
  */
  responseFormat?: {
    /** Schema name (OpenAI requires one; `[a-zA-Z0-9_-]`). */
    name: string;
    /** Pre-serialised JSON Schema object the output must conform to. */
    schema: Record<string, unknown>;
    /** Reject outputs that don't strictly match (OpenAI `strict`). Default true. */
    strict?: boolean;
  };
 /** Called before each transport-level retry (429 / 5xx / network). */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
 /** Called with a rate-limit snapshot when a provider response carried
  * rate-limit headers. Best-effort and observational (the session surfaces the
  * latest snapshot into the status-line payload). */
  onRateLimit?: (info: { requestsRemaining?: number; tokensRemaining?: number; resetsInSeconds?: number }) => void;
 /**
  * Tool-call policy: `"auto"` (default) lets the model decide; `"none"`
  * disables tool calls so the model MUST answer in text. Tool definitions
  * are still sent (keeps the prompt cache prefix stable). Omitted ⇒ auto.
  */
  toolChoice?: "auto" | "none";
}

export type StreamEvent =
  | { kind: "text_delta"; messageId: string; text: string }
  | { kind: "thinking_delta"; messageId: string; text: string }
  | {
      kind: "tool_input_delta";
      messageId: string;
      toolCallId: string;
      partialJson: string;
    }
  | {
      kind: "tool_call";
      messageId: string;
      toolCall: ToolUseBlock;
    }
  | { kind: "usage"; usage: UsageInfo }
  | { kind: "done"; finishReason: string }
  | { kind: "error"; message: string }
  /** Emitted by the fallback chain the moment it gives up on one provider and
   * re-issues the request against the next — purely observational, so a host
   * can surface which provider served the turn and why it switched. Carries the
   * from/to provider names, the triggering error message, and the structured
   * failover class. Never produced by a single provider's own stream. */
  | {
      kind: "provider_failover";
      from: string;
      to: string;
      reason: string;
      failureKind: string;
    };

export interface ChatProvider {
  readonly name: string;
 /** Default large model used when the caller doesn't override. */
  readonly defaultModel: string;
 /** Cheap model used for background work (compaction, titles). */
  readonly smallModel: string;
  stream(opts: StreamChatOptions): AsyncIterable<StreamEvent>;
 /**
  * OPTIONAL native fill-in-the-middle completion. Returns middle text for a
  * prefix+suffix in one call when the provider supports a FIM endpoint.
  * Used ONLY by inline completion; callers fall back to chat otherwise.
  */
  fim?(opts: FimCompletionOptions): Promise<FimCompletionResult>;
  /**
   * OPTIONAL exact prompt token count via the provider's count-tokens API.
   * Used ONLY on explicit demand (`/context --precise`), never on a hot path
   * or to drive compaction. Providers without the API fall back to the heuristic.
   */
  countTokens?(opts: CountTokensOptions): Promise<CountTokensResult>;
}

export interface CountTokensOptions {
  model: string;
  systemPrompt?: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  signal?: AbortSignal;
}

export interface CountTokensResult {
  /** Exact input (prompt) tokens the provider counts for this request. */
  inputTokens: number;
}

export interface FimCompletionOptions {
  model: string;
  /** Code before the cursor. */
  prefix: string;
  /** Code after the cursor. */
  suffix: string;
  /** Soft cap on generated tokens. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface FimCompletionResult {
  /** The generated middle text (already stripped of any stop sequence). */
  text: string;
}

/** Build a human-readable text rendering of a ContentBlock array. */
export function renderContent(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") {
        return `[tool_use:${b.name}] ${JSON.stringify(b.input)}`;
      }
      if (b.type === "tool_result") {
        return `[tool_result:${b.toolCallId}${b.isError ? " error" : ""}] ${
          b.content
        }`;
      }
      return "";
    })
    .join("\n");
}

/** Build a single user-content message that may include image attachments. */
export function userMessage(
  text: string,
  images?: ImageAttachment[]
): ProviderMessage {
  const content: ProviderMessageContent[] = [];
  for (const img of images ?? []) {
    content.push({ type: "image", mediaType: img.mediaType, base64: img.base64 });
  }
  content.push({ type: "text", text });
  return { role: "user", content };
}

/**
 * Collapse adjacent same-role messages into one. Same-role runs are rejected
 * by strict provider backends. Each provider supplies a `mergeInto(prev, cur)`
 * callback returning `true` when it absorbed `cur`. Inputs are shallow-cloned.
 */
export function mergeAdjacentRoles<T>(
  messages: readonly T[],
  mergeInto: (prev: T, cur: T) => boolean,
): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev !== undefined && mergeInto(prev, m)) continue;
    out.push({ ...(m as object) } as T);
  }
  return out;
}
