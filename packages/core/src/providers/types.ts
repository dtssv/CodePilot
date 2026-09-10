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
  signal?: AbortSignal;
  maxTokens?: number;
  /** Model reasoning effort (codex-style). Providers that support it
   *  (OpenAI o-series, DeepSeek) pass this through; others ignore it. */
  reasoningEffort?: "low" | "medium" | "high";
}

export type StreamEvent =
  | { kind: "text_delta"; messageId: string; text: string }
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
  | { kind: "error"; message: string };

export interface ChatProvider {
  readonly name: string;
  /** Default large model used when the caller doesn't override. */
  readonly defaultModel: string;
  /** Cheap model used for background work (compaction, titles). */
  readonly smallModel: string;
  stream(opts: StreamChatOptions): AsyncIterable<StreamEvent>;
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
