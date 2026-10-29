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
 * active collaboration mode. When `lazyMcp` is true, individual MCP tools are
 * dropped from the list (they're reached via the `mcp` meta-tool instead),
 * keeping the per-turn tool schema small when a server exposes many tools. */
export function buildProviderToolDefs(
  tools: ToolRegistry,
  mode: AgentMode,
  opts: { lazyMcp?: boolean } = {},
): ProviderToolDef[] {
  let visible = filterToolsByMode(tools.all(), mode);
  if (opts.lazyMcp) {
    visible = visible.filter((t) => t.source !== "mcp");
  }
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
 * Context management:
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
 /** Rolling tool-output window: fold old tool_results down to this many
 * before any budget pressure. */
    maxUnfoldedToolResults?: number;
 /** Invoked when micro-compaction folds ≥1 tool_result (observability). */
    onFolded?: (foldedCount: number) => void;
  } = {},
): ProviderMessage[] {
  const all = [...history, ...newEvents];
  const { events: folded, foldedCount } = foldForBudget(
    all,
    opts.contextBudget,
    opts.hardBudget,
    opts.maxUnfoldedToolResults,
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
  maxUnfoldedToolResults?: number,
): { events: Event[]; foldedCount: number } {
  // The first pass folds oversized old results (size-based) AND enforces the
  // rolling tool-output window (count-based, token-independent) so the live
  // transcript's backlog of small-but-numerous results stays bounded from the
  // start — not only once a budget threshold is crossed.
  const first = foldToolResults(events, {
    keepRecentMessages: 8,
    maxUnfoldedToolResults,
  });
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
  // Round-level image dedup: the exact same image often rides along multiple
  // turns (a user keeps a screenshot pinned,
  // or a tool re-attaches the same picture). Re-sending the bytes costs
  // ~1.5K tokens each time for zero new information. We send each distinct
  // payload once and replace later identical ones with a tiny text pointer so
  // the model still knows the image is "there" without paying for it again.
  const seenImages = new Map<string, number>();
  const imageBlocksFor = (
    imgs: readonly ImageAttachment[] | undefined,
  ): ProviderMessageContent[] => {
    const blocks: ProviderMessageContent[] = [];
    for (const img of imgs ?? []) {
      if (!img.base64) continue;
      const key = `${img.mediaType}:${img.base64.length}:${img.base64.slice(0, 64)}:${img.base64.slice(-64)}`;
      const prior = seenImages.get(key);
      if (prior === undefined) {
        seenImages.set(key, seenImages.size + 1);
        blocks.push({ type: "image", mediaType: img.mediaType, base64: img.base64 });
      } else {
        blocks.push({
          type: "text",
          text: `[same image as #${prior} above — omitted to save context]`,
        });
      }
    }
    return blocks;
  };

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
      blocks.push(...imageBlocksFor(msgImages));
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
 // Deduped round-level so a re-attached picture isn't paid for twice.
      const imgs = imageBlocksFor(e.images);
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

/** Stream one provider turn. The session-stable context rides the cached system
 * block; the volatile per-turn context (now / git / plan) is appended as its own
 * separate `system`-role message after the user turn. */
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
  // Cached system block = static harness prefix + session-stable context
  // (environment identity + memory index + tools). Byte-stable across turns →
  // served from the provider's prompt cache after the first turn.
  const systemBlock = sys
    ? sys.staticPrefix +
      (sys.stableContext ? `${sys.staticPrefix.endsWith("\n") ? "" : "\n"}\n${sys.stableContext}` : "")
    : undefined;
  // Per-turn tail = only the volatile context (now / git working-tree / plan).
  // Fall back to `dynamicSuffix` for older callers that don't set volatileSuffix.
  let perTurn = sys?.volatileSuffix ?? sys?.dynamicSuffix;
  if (sys && extra.liveContext) {
    const live = extra.liveContext;
    perTurn = perTurn?.includes("<plan>")
      ? perTurn.replace(/<plan>[\s\S]*?<\/plan>/, () => live)
      : `${perTurn ? `${perTurn}\n\n` : ""}${live}`;
  }
  // Runtime context is NOT a user message: it's harness-injected per-turn state
  // (now / git working-tree / plan). Emit it as its own separate `system`-role
  // message placed JUST BEFORE the current turn (the last user / tool-result
  // message), so background is stated first and the user's actual request stays
  // last — the strongest-attention, closest-to-generation position, and the
  // instruction the model should act on. Providers that honor mid-conversation
  // system messages (OpenAI-compatible) treat it as harness context; on
  // Anthropic (no mid-stream system role) it degrades to user and is merged
  // with an adjacent user message to satisfy role alternation.
  let effectiveMessages = messages;
  const dynamicSuffix = perTurn;
  if (dynamicSuffix && dynamicSuffix.trim().length > 0 && messages.length > 0) {
    const note = `<runtime_context>\n${dynamicSuffix}\n</runtime_context>`;
    const contextMsg: ProviderMessage = { role: "system", content: [{ type: "text", text: note }] };
    // Normally insert just before the current turn (last message). But the
    // runtime_context is a `system`-role message, and OpenAI-compatible
    // backends require a `tool`-role result to IMMEDIATELY follow the
    // assistant message that issued the tool_calls — nothing (not even a
    // system message) may sit between them. On a continuation turn the tail is
    // `assistant(tool_calls) → user(tool_result…)`, so inserting at length-1
    // would split that pair and the upstream rejects it with
    // `invalid_argument` (observed on GLM-5.2). Back the insert point up past
    // any trailing tool_result-bearing messages AND the assistant tool_calls
    // turn they answer, so the context lands on a clean role boundary.
    let insertAt = messages.length - 1;
    const carriesToolResult = (m: ProviderMessage): boolean =>
      Array.isArray(m.content) &&
      m.content.some((c) => (c as { type?: string }).type === "tool_result");
    const hasToolUse = (m: ProviderMessage): boolean =>
      Array.isArray(m.content) &&
      m.content.some((c) => (c as { type?: string }).type === "tool_use");
    // Skip back over the trailing run of tool_result messages…
    while (insertAt > 0 && carriesToolResult(messages[insertAt]!)) insertAt--;
    // …and if that run is answering an assistant tool_calls turn, place the
    // context before that assistant turn too (never between the pair).
    while (insertAt > 0 && hasToolUse(messages[insertAt - 1]!)) insertAt--;
    effectiveMessages = [...messages.slice(0, insertAt), contextMsg, ...messages.slice(insertAt)];
  } else if (dynamicSuffix && dynamicSuffix.trim().length > 0) {
    // No prior messages (degenerate): context goes first.
    effectiveMessages = [{ role: "system", content: [{ type: "text", text: `<runtime_context>\n${dynamicSuffix}\n</runtime_context>` }] }];
  }
  void messageId;
  yield* provider.stream({
    model: deps.config.model ?? provider.defaultModel,
    messages: effectiveMessages,
    tools,
    systemPrompt: systemBlock,
    signal: deps.signal,
    maxTokens: deps.config.maxTokens,
    reasoningEffort: deps.config.reasoningEffort,
    thinkingBudget: deps.config.thinkingBudget,
    promptCacheKey: deps.promptCacheKey,
    responseFormat: deps.responseFormat,
    onRetry: extra.onRetry,
  });
}
