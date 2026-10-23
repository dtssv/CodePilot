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
  StreamChatOptions,
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
import { formatUploadNote } from "./promptFiles.js";
import { filterToolsByMode } from "./tools/modes.js";
import { estimateEventTokens, foldToolResults, trimEventsToBudget } from "./compaction.js";
import { estimateTokens } from "./tokens.js";

// ---------------------------------------------------------------------------
// Tool-table construction
// ---------------------------------------------------------------------------

/** Build the provider-facing tool definitions for a turn, filtered by the
 * active collaboration mode. */
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
 * Context management (Codex / OpenCode / Pi):
 * 1. Soft fold — stub old tool_results toward `contextBudget` (speed).
 * 2. Hard trim — if still over `hardBudget` (model window minus reserves),
 *    drop oldest turns / images so the request cannot exceed the configured
 *    context length. Operates on a COPY — persisted JSONL is untouched.
 */
export function buildProviderMessages(
  history: Event[],
  newEvents: Event[],
  userText: string,
  images?: ImageAttachment[],
  opts: {
    /** Soft fold target (default aggressiveness for long runs). */
    contextBudget?: number;
    /** Hard ceiling — must not send more than this many event tokens. */
    hardBudget?: number;
 /** Invoked when micro-compaction folds ≥1 tool_result (observability). */
    onFolded?: (foldedCount: number) => void;
  } = {},
): ProviderMessage[] {
  const all = [...history, ...newEvents];
  const { events: folded, foldedCount } = foldForBudget(
    all,
    opts.contextBudget,
    opts.hardBudget,
  );
  if (foldedCount > 0) {
    try {
      opts.onFolded?.(foldedCount);
    } catch {
 /* never let a listener throw */
    }
  }
 // The run's own user message is the first user message it produced; the
 // prompt's images ride on it (they are not part of the persisted event).
  const runUser = newEvents.find(
    (e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user",
  );
  return compactTranscriptToProviderMessages(folded, userText, images, runUser?.id);
}

/**
 * Fold old tool results toward the soft budget, then hard-trim to the
 * model window. Long single-prompt runs never reach the post-prompt
 * compaction alone, so this is what keeps each turn inside the window.
 */
function foldForBudget(
  events: Event[],
  softBudget: number | undefined,
  hardBudget?: number,
): { events: Event[]; foldedCount: number } {
  const first = foldToolResults(events, { keepRecentMessages: 8 });
  let out = first.events;
  let totalFolded = first.foldedCount;
  const soft = softBudget && softBudget > 0 ? softBudget : undefined;
  if (soft) {
    for (const keep of [6, 4, 2]) {
      if (estimateEventTokens(out, estimateTokens) < soft * 0.75) break;
      const next = foldToolResults(out, { keepRecentMessages: keep, minChars: 160 });
      totalFolded += next.foldedCount;
      out = next.events;
    }
  }
  const hard =
    hardBudget && hardBudget > 0
      ? hardBudget
      : soft;
  if (hard && estimateEventTokens(out, estimateTokens) > hard) {
    const trimmed = trimEventsToBudget(out, hard, { keepRecentMessages: 4 });
    out = trimmed.events;
    totalFolded += trimmed.foldedCount;
  }
  return { events: out, foldedCount: totalFolded };
}

const INTERRUPTED_RESULT =
  "[not executed: the turn was interrupted before this tool ran. Re-issue the call only if you still need it.]";

/**
 * Map the internal event transcript into the provider's message format.
 *
 * The event log records each tool call twice (a `tool_call` event while
 * streaming and a `tool_use` block in the assistant message) and each result
 * as a `tool_result` event. Providers need exactly one `tool_use` per id,
 * every `tool_use` answered by one `tool_result` in the following user turn,
 * and strictly alternating roles; this function normalises to that shape.
 */
export function compactTranscriptToProviderMessages(
  transcript: Event[],
  fallbackUserText: string,
  images?: ImageAttachment[],
  imagesForMessageId?: string,
): ProviderMessage[] {
  const callsInMessages = new Set<string>();
  const resultEvents = new Set<string>();
  for (const e of transcript) {
    if (e.type === "message" && e.role === "assistant") {
      for (const b of e.content) if (b.type === "tool_use") callsInMessages.add(b.id);
    } else if (e.type === "tool_result") {
      resultEvents.add(e.toolCallId);
    }
  }

  const out: ProviderMessage[] = [];
  const emittedCalls = new Set<string>();
  const answered = new Set<string>();
  let open: string[] = [];
  let attachedImages = false;

  const push = (role: "user" | "assistant", blocks: ProviderMessageContent[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
 // Results must lead the user turn that answers a tool_use.
      const merged = [...last.content, ...blocks];
      if (role === "user") {
        merged.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
      }
      out[out.length - 1] = { role, content: merged };
    } else {
      out.push({ role, content: blocks });
    }
  };

  const pushResult = (block: ProviderMessageContent & { type: "tool_result" }, extra: ProviderMessageContent[] = []): void => {
    if (!emittedCalls.has(block.toolCallId) || answered.has(block.toolCallId)) return;
    answered.add(block.toolCallId);
    open = open.filter((id) => id !== block.toolCallId);
    push("user", [block, ...extra]);
  };

  const closeOpenCalls = (): void => {
    for (const id of open) {
      answered.add(id);
      push("user", [{ type: "tool_result", toolCallId: id, content: INTERRUPTED_RESULT, isError: true }]);
    }
    open = [];
  };

  const addCall = (id: string, name: string, input: unknown): ProviderMessageContent | null => {
    if (emittedCalls.has(id)) return null;
    emittedCalls.add(id);
    open.push(id);
    return { type: "tool_use", id, name, input };
  };

  for (const e of transcript) {
    if (e.type === "message") {
      if (e.role === "assistant") {
 // A new assistant turn while calls from an earlier one are still
 // unanswered means those were never run.
        const prev = out[out.length - 1];
        if (open.length > 0 && !(prev && prev.role === "assistant")) closeOpenCalls();
        const blocks: ProviderMessageContent[] = [];
        const strayResults: ProviderMessageContent[] = [];
        for (const b of e.content) {
          if (b.type === "text") {
            if (b.text !== "") blocks.push({ type: "text", text: b.text });
          } else if (b.type === "reasoning") {
            // Persisted for audit/export only — do not re-send to the provider.
            continue;
          } else if (b.type === "tool_use") {
            const call = addCall(b.id, b.name, b.input);
            if (call) blocks.push(call);
          } else if (b.type === "tool_result" && !resultEvents.has(b.toolCallId)) {
            strayResults.push({ type: "tool_result", toolCallId: b.toolCallId, content: b.content, isError: b.isError });
          }
        }
        push("assistant", blocks);
        for (const r of strayResults) pushResult(r as ProviderMessageContent & { type: "tool_result" });
        continue;
      }
      const blocks: ProviderMessageContent[] = [];
      for (const b of e.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text });
      }
 // Tell the model where uploads live without putting that note in the
 // user-visible bubble (the UI renders `e.files` as chips).
      if (e.files?.length) {
        const note = formatUploadNote(e.files);
        if (note) {
          const last = blocks[blocks.length - 1];
          if (last?.type === "text") {
            last.text = last.text.trim() ? `${last.text.trim()}\n\n${note}` : note;
          } else {
            blocks.push({ type: "text", text: note });
          }
        }
      }
      let msgImages = e.images;
      if (!attachedImages && imagesForMessageId !== undefined && e.id === imagesForMessageId) {
        attachedImages = true;
        msgImages ??= images;
      }
      for (const img of msgImages ?? []) {
        blocks.push({ type: "image", mediaType: img.mediaType, base64: img.base64 });
      }
      closeOpenCalls();
      push("user", blocks);
      continue;
    }
    if (e.type === "tool_call") {
      if (callsInMessages.has(e.id)) continue;
      const call = addCall(e.id, e.name, e.input);
      if (call) push("assistant", [call]);
      continue;
    }
    if (e.type === "tool_result") {
 // Image-capable tools (read_image) attach images to the tool_result.
 // They ride as sibling image blocks in the same user turn so a
 // multimodal model sees the picture alongside the tool's text result.
      const imgs: ProviderMessageContent[] = (e.images ?? []).map((img) => ({
        type: "image",
        mediaType: img.mediaType,
        base64: img.base64,
      }));
      pushResult({ type: "tool_result", toolCallId: e.toolCallId, content: e.content, isError: e.isError }, imgs);
      continue;
    }
    if (e.type === "compaction") {
      closeOpenCalls();
      push("user", [{ type: "text", text: `[Earlier conversation summary]\n${e.summary}` }]);
      continue;
    }
 // message_delta / plan / usage / status / error are ignored here.
  }
  closeOpenCalls();
  if (out.length === 0 && fallbackUserText) {
    const blocks: ProviderMessageContent[] = [
      { type: "text", text: fallbackUserText },
    ];
    for (const img of images ?? []) {
      blocks.push({ type: "image", mediaType: img.mediaType, base64: img.base64 });
    }
    out.push({ role: "user", content: blocks });
  }
 // Providers reject a conversation that opens on the assistant side (it
 // happens when compaction cut the leading user turn).
  if (out[0]?.role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(continuing the conversation)" }] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider streaming
// ---------------------------------------------------------------------------

function findLastIndex<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
  return -1;
}

/** Stream one provider turn, injecting the dynamic system-prompt suffix into
 * the final user message as a `<runtime_context>` note (keeps the static
 * prefix cache-friendly). */
export async function* streamOnce(
  provider: ChatProvider,
  deps: AgentDeps,
  messages: ProviderMessage[],
  tools: ProviderToolDef[],
  messageId: string,
  extra: {
 /** Fresh per-turn context (live plan + progress); replaces the
 * prompt-start `<plan>` block of the dynamic suffix. */
    liveContext?: string;
    onRetry?: StreamChatOptions["onRetry"];
  } = {},
): AsyncIterable<StreamEvent> {
  const sys = deps.systemPrompt;
  const staticPrefix = sys?.staticPrefix;
  let dynamicSuffix = sys?.dynamicSuffix;
  if (sys && extra.liveContext) {
    const live = extra.liveContext;
    dynamicSuffix = dynamicSuffix?.includes("<plan>")
      ? dynamicSuffix.replace(/<plan>[\s\S]*?<\/plan>/, () => live)
      : `${dynamicSuffix ? `${dynamicSuffix}\n\n` : ""}${live}`;
  }
 // Static prefix goes to the system prompt (cache-friendly). The dynamic
 // suffix (env, git, memory, plan) is appended to the final user message as
 // a <runtime_context> note so it stays fresh per turn without busting the
 // cached prefix. Messages here are provider-bound copies, safe to derive.
  let effectiveMessages = messages;
  if (dynamicSuffix && dynamicSuffix.trim().length > 0) {
    effectiveMessages = [...messages];
    const note = `<runtime_context>\n${dynamicSuffix}\n</runtime_context>`;
    const last = effectiveMessages[effectiveMessages.length - 1];
    const lastResultIdx = last ? findLastIndex(last.content, (c) => c.type === "tool_result") : -1;
    if (last && last.role === "user" && lastResultIdx >= 0) {
 // Mid-run turn: the "user" message is really tool results. A sibling
 // text block becomes a separate user turn on OpenAI-style APIs, which
 // weaker models read as a fresh request and re-run the last real
 // instruction (e.g. asking the same question again). Ride inside the
 // tool result instead, labelled as system context.
      const content = [...last.content];
      const block = content[lastResultIdx] as Extract<ProviderMessage["content"][number], { type: "tool_result" }>;
      content[lastResultIdx] = {
        ...block,
        content:
          `${block.content}\n\n<system-reminder>\nRuntime context refreshed by the harness — not a new user message. ` +
          `Continue from the tool results above.\n${note}\n</system-reminder>`,
      };
      effectiveMessages[effectiveMessages.length - 1] = { ...last, content };
    } else if (last && last.role === "user") {
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
    thinkingBudget: deps.config.thinkingBudget,
    onRetry: extra.onRetry,
  });
}
