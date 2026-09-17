// Provider message construction for the agent loop.
//
// Extracted from `agent.ts` so the ~150 lines of transcript-to-provider-
// message conversion (folding, compaction, block mapping) live in a focused
// module that is easy to test in isolation. `runAgent` calls
// `buildProviderMessages` once per turn.

import type {
  ChatProvider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolDef,
  StreamEvent,
} from "./providers/types.js";
import { ToolRegistry, type ToolContext } from "./tools/types.js";
import { zodToJsonSchema } from "./tools/types.js";
import type {
  AgentDeps,
} from "./agent.js";
import type {
  AgentMode,
  Event,
  ImageAttachment,
} from "./types.js";
import { filterToolsByMode } from "./tools/modes.js";
import { foldToolResults } from "./compaction.js";

// ---------------------------------------------------------------------------
// Tool-table construction
// ---------------------------------------------------------------------------

/** Build the provider-facing tool definitions for a turn, filtered by the
 *  active collaboration mode. */
export function buildProviderToolDefs(
  tools: ToolRegistry,
  mode: AgentMode,
): ProviderToolDef[] {
  const visible = filterToolsByMode(tools.all(), mode);
  return visible.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  }));
}

// ---------------------------------------------------------------------------
// Transcript → provider messages
// ---------------------------------------------------------------------------

/**
 * Build the provider message list for a turn.
 *
 * History is the persisted transcript; newEvents is the events produced so
 * far in the current run (we already appended the user message, so we omit
 * `userText` here). The agent loop is responsible for sending the user
 * message once at the start of the run.
 *
 * Micro-compaction (opencode-style prune): before sending, fold old
 * tool_result events (everything before the last 8 messages) into short
 * stubs that keep the artifactRef. This operates on a COPY of the event
 * list — the persisted JSONL transcript is untouched.
 */
export function buildProviderMessages(
  history: Event[],
  newEvents: Event[],
  userText: string,
  images?: ImageAttachment[],
): ProviderMessage[] {
  const folded = foldToolResults([...history, ...newEvents], {
    keepRecentMessages: 8,
  });
  return compactTranscriptToProviderMessages(folded.events, userText, images);
}

/** Map the internal event transcript into the provider's message format,
 *  coalescing consecutive same-role messages and synthesising user-role
 *  turns for tool_result events (most providers expect tool_result on the
 *  user side). */
export function compactTranscriptToProviderMessages(
  transcript: Event[],
  fallbackUserText: string,
  images?: ImageAttachment[],
): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let buffer:
    | { role: "user" | "assistant"; blocks: ProviderMessageContent[] }
    | null = null;

  const flush = (): void => {
    if (!buffer) return;
    if (buffer.blocks.length > 0) {
      out.push({ role: buffer.role, content: buffer.blocks });
    }
    buffer = null;
  };

  for (const e of transcript) {
    if (e.type === "message") {
      flush();
      const blocks: ProviderMessageContent[] = [];
      for (const b of e.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b.type === "tool_use")
          blocks.push({
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: b.input,
          });
        else if (b.type === "tool_result")
          blocks.push({
            type: "tool_result",
            toolCallId: b.toolCallId,
            content: b.content,
            isError: b.isError,
          });
      }
      buffer = { role: e.role, blocks };
      continue;
    }
    if (e.type === "tool_call") {
      if (!buffer || buffer.role !== "assistant") {
        flush();
        buffer = { role: "assistant", blocks: [] };
      }
      buffer.blocks.push({
        type: "tool_use",
        id: e.id,
        name: e.name,
        input: e.input,
      });
      continue;
    }
    if (e.type === "tool_result") {
      // tool_results come AFTER the assistant message that contained the
      // tool_use; we synthesise a user-role turn carrying them, since most
      // providers expect tool_result as a user-side message.
      flush();
      const blocks: ProviderMessageContent[] = [
        {
          type: "tool_result",
          toolCallId: e.toolCallId,
          content: e.content,
          isError: e.isError,
        },
      ];
      // Image-capable tools (read_image) attach images to the tool_result.
      // We emit them as sibling image blocks in the same user turn so a
      // multimodal model sees the picture alongside the tool's text result.
      for (const img of e.images ?? []) {
        blocks.push({
          type: "image",
          mediaType: img.mediaType,
          base64: img.base64,
        });
      }
      out.push({ role: "user", content: blocks });
      continue;
    }
    if (e.type === "compaction") {
      flush();
      out.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `[Earlier conversation summary]\n${e.summary}`,
          },
        ],
      });
      continue;
    }
    // message_delta / plan / usage / status / error are ignored here.
  }
  flush();
  if (out.length === 0 && fallbackUserText) {
    const blocks: ProviderMessageContent[] = [
      { type: "text", text: fallbackUserText },
    ];
    for (const img of images ?? []) {
      blocks.push({ type: "image", mediaType: img.mediaType, base64: img.base64 });
    }
    out.push({ role: "user", content: blocks });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider streaming
// ---------------------------------------------------------------------------

/** Stream one provider turn, injecting the dynamic system-prompt suffix into
 *  the final user message as a `<runtime_context>` note (keeps the static
 *  prefix cache-friendly). */
export async function* streamOnce(
  provider: ChatProvider,
  deps: AgentDeps,
  messages: ProviderMessage[],
  tools: ProviderToolDef[],
  messageId: string,
): AsyncIterable<StreamEvent> {
  const sys = deps.systemPrompt;
  const staticPrefix = sys?.staticPrefix;
  const dynamicSuffix = sys?.dynamicSuffix;
  // Static prefix goes to the system prompt (cache-friendly). The dynamic
  // suffix (env, git, memory, plan) is appended to the final user message as
  // a <runtime_context> note so it stays fresh per turn without busting the
  // cached prefix. Messages here are provider-bound copies, safe to derive.
  let effectiveMessages = messages;
  if (dynamicSuffix && dynamicSuffix.trim().length > 0) {
    effectiveMessages = [...messages];
    const note = `<runtime_context>\n${dynamicSuffix}\n</runtime_context>`;
    const last = effectiveMessages[effectiveMessages.length - 1];
    if (last && last.role === "user") {
      effectiveMessages[effectiveMessages.length - 1] = {
        ...last,
        content: [...last.content, { type: "text", text: "\n\n" + note }],
      };
    } else {
      effectiveMessages.push({
        role: "user",
        content: [{ type: "text", text: note }],
      });
    }
  }
  void messageId;
  yield* provider.stream({
    model: deps.config.model ?? provider.defaultModel,
    messages: effectiveMessages,
    tools,
    systemPrompt: staticPrefix,
    signal: deps.signal,
    maxTokens: deps.config.maxTokens,
    reasoningEffort: deps.config.reasoningEffort,
  });
}
