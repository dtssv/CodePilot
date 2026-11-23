// Provider message construction for the agent loop: transcript-to-provider
// message conversion (folding, compaction, block mapping). `runAgent` calls
// `buildProviderMessages` once per turn.

import type {
  ChatProvider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolDef,
  StreamChatOptions,
  StreamEvent,
} from "../providers/types.js";
import { ToolRegistry, type ToolDef } from "../tools/types.js";
import { toProviderToolDef } from "../tools/schemaCache.js";
import type {
  AgentDeps,
} from "./agent-types.js";
import type {
  AgentMode,
  Event,
  ImageAttachment,
} from "../types.js";
import { formatUploadNote } from "../workspace/promptFiles.js";
import { filterToolsByMode, filterToolsByModel, type ToolExposureRule } from "../tools/modes.js";
import { isDirectWireTool } from "../tools/wirePolicy.js";
import {
  estimateEventTokens,
  foldToolResults,
  trimEventsToBudget,
} from "../compaction/compaction.js";
import { estimateTokens } from "../compaction/tokens.js";

// ---------------------------------------------------------------------------
// Tool-table construction
// ---------------------------------------------------------------------------

/** Decide whether a turn lazily surfaces MCP tools (hide individual schemas,
 * expose only the `mcp` meta-tool). "lazy" always defers, "eager" never,
 * "auto" (default) defers once MCP tool count exceeds the threshold (default 2). */
export function decideLazyMcp(
  mcpToolCount: number,
  discovery: "auto" | "lazy" | "eager" | undefined,
  lazyThreshold: number | undefined,
): boolean {
  if (mcpToolCount <= 0) return false;
  const mode = discovery ?? "auto";
  if (mode === "lazy") return true;
  if (mode === "eager") return false;
  // Default threshold 2 — align with progressive MCP disclosure: defer schemas
  // early so the tools block stays small (override via mcpLazyThreshold).
  return mcpToolCount > (lazyThreshold ?? 2);
}

/** Provider-facing tool definitions for a turn (mode + exposure filtered).
 * With `previouslyAdvertised` the wire set is session-monotonic: names already
 * sent stay even if mode/lazy would drop them (execute-time deny still
 * enforces mode). Stable order: builtin → plugin → mcp, then name. */
export function buildProviderToolDefs(
  tools: ToolRegistry,
  mode: AgentMode,
  opts: TurnToolFilterOptions = {},
): ProviderToolDef[] {
  return selectToolsForTurn(tools, mode, opts).map(toProviderToolDef);
}

/** Options for the per-turn tool filter chain. `lazyMcp` / `lazyPlugin` hide
 * the individual schemas of that source (reached on demand through the `mcp` /
 * `tool_catalog` meta-tool, which are themselves built-ins and stay visible). */
export interface TurnToolFilterOptions {
  lazyMcp?: boolean;
  lazyPlugin?: boolean;
  model?: string;
  toolExposure?: ToolExposureRule[];
  /** Names already advertised this session; re-included so mode/lazy flips
   * never shrink the tools prefix. Under `deferredWire` only direct-allowlist
   * names may sticky. */
  previouslyAdvertised?: ReadonlySet<string>;
  /** Keep only the direct-wire allowlist on `tools[]`; deferred tools are
   * reached via `code_mode.tools.*`. */
  deferredWire?: boolean;
}

/** Source rank for contiguous cache prefix: builtins first. */
function sourceRank(source: ToolDef["source"]): number {
  if (source === "plugin") return 1;
  if (source === "mcp") return 2;
  return 0; // builtin / undefined
}

/** Stable sort: builtin → plugin → mcp, then name. */
export function sortToolsForCache(tools: readonly ToolDef[]): ToolDef[] {
  return tools.slice().sort((a, b) => {
    const d = sourceRank(a.source) - sourceRank(b.source);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });
}

/** Mode → lazy → exposure → deferred-wire allowlist → session-monotonic union
 * (direct-only when `deferredWire`) → stable sort. */
export function selectToolsForTurn(
  tools: ToolRegistry,
  mode: AgentMode,
  opts: TurnToolFilterOptions = {},
): ToolDef[] {
  let visible = filterToolsByMode(tools.all(), mode);
  // deferredWire implies MCP/plugin schemas never ride the wire (even if
  // discovery is "eager"); otherwise honour explicit lazy flags.
  if (opts.deferredWire || opts.lazyMcp) {
    visible = visible.filter((t) => t.source !== "mcp");
  }
  if (opts.deferredWire || opts.lazyPlugin) {
    visible = visible.filter((t) => t.source !== "plugin");
  }
  if (opts.model && opts.toolExposure && opts.toolExposure.length > 0) {
    visible = filterToolsByModel(visible, opts.model, opts.toolExposure);
  }
  if (opts.deferredWire) {
    visible = visible.filter(isDirectWireTool);
  }

  const prev = opts.previouslyAdvertised;
  if (prev && prev.size > 0) {
    const byName = new Map(visible.map((t) => [t.name, t]));
    for (const name of prev) {
      if (byName.has(name)) continue;
      // Never sticky-advertise deferred tools under deferredWire.
      if (opts.deferredWire && !isDirectWireTool(name)) continue;
      const kept = tools.get(name);
      if (!kept) continue;
      if (opts.deferredWire && !isDirectWireTool(kept)) continue;
      byName.set(name, kept);
    }
    visible = [...byName.values()];
  }

  return sortToolsForCache(visible);
}

/** Names the model is told it can call this turn — the same filter chain as
 * `buildProviderToolDefs`, so the system-prompt ad never lists an omitted tool. */
export function listAdvertisedToolNames(
  tools: ToolRegistry,
  mode: AgentMode,
  opts: TurnToolFilterOptions = {},
): string[] {
  return selectToolsForTurn(tools, mode, opts).map((t) => t.name);
}

/** Record the final wire names into a session set (monotonic growth). */
export function rememberAdvertisedToolNames(
  advertised: Set<string>,
  names: readonly string[],
): void {
  for (const n of names) advertised.add(n);
}

// ---------------------------------------------------------------------------
// Transcript → provider messages
// ---------------------------------------------------------------------------

/**
 * Build the provider message list for a turn: history (persisted transcript)
 * + newEvents (current run). Soft-folds old tool_results toward
 * `contextBudget`, then hard-trims to `hardBudget`. Operates on a COPY.
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
 /** Freeze map so a folded toolCallId keeps the same stub across turns. */
    stubMemo?: Map<string, string>;
 /** Default path: size-fold large old results with a fixed keep window (no
  * rolling count, no soft escalate). */
    stableSizeFold?: boolean;
 /** Invoked when micro-compaction folds ≥1 tool_result (observability). */
    onFolded?: (foldedCount: number) => void;
 /** Drop every inline image from the send view. Used by the payload-too-large
  * recovery path (images are the usual byte-size cause and can't be token-compacted). */
    dropImages?: boolean;
  } = {},
): ProviderMessage[] {
  const all = [...history, ...newEvents];
  const { events: folded, foldedCount } = foldForBudget(
    all,
    opts.contextBudget,
    opts.hardBudget,
    opts.maxUnfoldedToolResults,
    opts.stubMemo,
    opts.stableSizeFold === true,
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
  const sendEvents = opts.dropImages ? folded.map(stripEventImages) : folded;
  return compactTranscriptToProviderMessages(
    sendEvents,
    userText,
    opts.dropImages ? undefined : images,
    runUser?.id,
  );
}

/** Return a copy of `e` with any inline images removed (the image block on a
 * message/tool_result). Non-image events pass through unchanged. */
function stripEventImages(e: Event): Event {
  if ((e.type === "message" || e.type === "tool_result") && "images" in e && e.images) {
    const { images: _drop, ...rest } = e;
    return rest as Event;
  }
  return e;
}

/**
 * Optional mid-history fold (soft budget / rolling window / size-fold), then
 * hard-trim to the model window. Folds are opt-in: each rewrites already-sent
 * tool_result bodies and invalidates the cached prefix from that point, so the
 * default path prefers first-write spill + summary compaction.
 */
function foldForBudget(
  events: Event[],
  softBudget: number | undefined,
  hardBudget?: number,
  maxUnfoldedToolResults?: number,
  stubMemo?: Map<string, string>,
  stableSizeFold = false,
): { events: Event[]; foldedCount: number } {
  let out = events;
  let totalFolded = 0;
  const soft = softBudget && softBudget > 0 ? softBudget : undefined;
  const rolling =
    maxUnfoldedToolResults !== undefined && maxUnfoldedToolResults >= 0
      ? maxUnfoldedToolResults
      : undefined;

  if (soft !== undefined || rolling !== undefined || stableSizeFold) {
    const first = foldToolResults(events, {
      keepRecentMessages: 8,
      ...(rolling !== undefined ? { maxUnfoldedToolResults: rolling } : {}),
      // Rolling-only: skip size gate (count pressure alone). Soft / stable
      // size-fold use the default minChars (~1200).
      ...(soft === undefined && rolling !== undefined && !stableSizeFold
        ? { minChars: Number.POSITIVE_INFINITY }
        : {}),
      ...(stubMemo ? { stubMemo } : {}),
    });
    out = first.events;
    totalFolded = first.foldedCount;
  }
  if (soft) {
    for (const keep of [6, 4, 2]) {
      if (estimateEventTokens(out, estimateTokens) < soft * 0.75) break;
      const next = foldToolResults(out, {
        keepRecentMessages: keep,
        minChars: 160,
        ...(stubMemo ? { stubMemo } : {}),
      });
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

// Synthetic result for a tool_use left unanswered when the turn was cut off
// (crash/restart/interrupt). Outcome is genuinely UNKNOWN — the interrupt may
// have landed after the tool started or finished. Telling the model to blindly
// re-issue would double a mutating action; verify real state before re-running.
export const INTERRUPTED_RESULT =
  "[interrupted: the turn was cut off before this tool's result was recorded, so its outcome is " +
  "UNKNOWN — it may not have run, or may have already taken effect. Do NOT blindly re-issue it. " +
  "If the call is read-only or idempotent, you may safely retry. If it could have side effects " +
  "(writing/editing files, running commands, network or data changes), first verify the actual " +
  "state (e.g. re-read the file or list the resource) or ask the user before re-running.]";

// Synthetic result for a tool_use that was cut off BEFORE it started executing
// — there is no `tool_started` marker, so the call never reached its handler
// (killed while waiting on permission, or before dispatch). It had no chance to
// take effect, so re-issuing it is safe regardless of whether it mutates state.
export const NOT_STARTED_RESULT =
  "[interrupted: the turn was cut off before this tool started running, so it had no effect. " +
  "It is safe to re-issue the call.]";

/**
 * Map the internal event transcript into the provider's message format.
 * Normalises the duplicated tool_call/tool_use records into one `tool_use`
 * per id, each answered by one `tool_result`, with strictly alternating roles.
 */
export function compactTranscriptToProviderMessages(
  transcript: Event[],
  fallbackUserText: string,
  images?: ImageAttachment[],
  imagesForMessageId?: string,
): ProviderMessage[] {
  const callsInMessages = new Set<string>();
  const resultEvents = new Set<string>();
  // Calls that reached execution (a `tool_started` marker was persisted). An
  // orphan with a marker sealed as outcome-unknown; without one, never-started.
  const startedCalls = new Set<string>();
  for (const e of transcript) {
    if (e.type === "message" && e.role === "assistant") {
      for (const b of e.content) if (b.type === "tool_use") callsInMessages.add(b.id);
    } else if (e.type === "tool_result") {
      resultEvents.add(e.toolCallId);
    } else if (e.type === "tool_started") {
      startedCalls.add(e.toolCallId);
    }
  }

  const out: ProviderMessage[] = [];
  const emittedCalls = new Set<string>();
  const answered = new Set<string>();
  let open: string[] = [];
  let attachedImages = false;
  // Round-level image dedup: the same image often rides multiple turns; send
  // each distinct payload once and replace later identical ones with a text
  // pointer (saves ~1.5K tokens each).
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
      const content = startedCalls.has(id) ? INTERRUPTED_RESULT : NOT_STARTED_RESULT;
      push("user", [{ type: "tool_result", toolCallId: id, content, isError: true }]);
    }
    open = [];
  };

  const addCall = (id: string, name: string, input: unknown): ProviderMessageContent | null => {
    if (emittedCalls.has(id)) return null;
    emittedCalls.add(id);
    open.push(id);
    // Send the sealed tool_use input verbatim. Oversized args are bounded
    // once at seal time (runAgent); re-truncating here rewrites mid-history
    // relative to a previously cached full body and busts prefix cache.
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
 // Image-capable tools attach images to the tool_result; they ride as sibling
 // image blocks in the same user turn so a multimodal model sees the picture.
 // Deduped round-level.
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
 * block; the volatile per-turn context (now / plan / stall / budget) is appended
 * as its own trailing `system`-role message so the conversation prefix stays
 * byte-stable for implicit prompt caches (OpenAI / GLM). Harness nudges go at
 * the request tail, never spliced into mid-history. */
export async function* streamOnce(
  provider: ChatProvider,
  deps: AgentDeps,
  messages: ProviderMessage[],
  tools: ProviderToolDef[],
  messageId: string,
  extra: {
 /** Fresh per-turn context (live plan when one exists + progress). Replaces
 * a prompt-start `<plan>` block when present; otherwise appended. */
    liveContext?: string;
    onRetry?: StreamChatOptions["onRetry"];
    onRateLimit?: StreamChatOptions["onRateLimit"];
 /** Tool-call policy for this turn (see StreamChatOptions.toolChoice). */
    toolChoice?: StreamChatOptions["toolChoice"];
 /** Per-request mid-stream steer signal (see AgentDeps.getSteerSignal). */
    steerSignal?: AbortSignal;
 /**
  * Tool-lock / wrap-up instruction. Appended as a trailing
  * `user` message AFTER `<runtime_context>` so system + tools + history keep a
  * byte-stable cached prefix; only this suffix (and `toolChoice:"none"`) change.
  * Not persisted to the event log.
  */
    trailingUser?: string;
  } = {},
): AsyncIterable<StreamEvent> {
  const sys = deps.systemPrompt;
  // Cached system = static harness prefix + session-stable context
  // (lean env / git / memory index / skills). Anthropic gets them as separate
  // cache_control blocks; other providers join into one string.
  // IMPORTANT: do NOT fold `dynamicSuffix` into the system block — older
  // callers (plugin runtimes) still append per-turn notes there, and the
  // pre-split contract was `perTurn = volatileSuffix ?? dynamicSuffix`.
  const systemBlocks = sys
    ? [sys.staticPrefix, sys.stableContext].filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      )
    : undefined;
  const systemBlock = systemBlocks && systemBlocks.length > 0
    ? systemBlocks.join(sys!.staticPrefix.endsWith("\n") ? "\n" : "\n\n")
    : undefined;
  // Per-turn tail = volatile context (now + plan + session notes).
  // Fall back to `dynamicSuffix` for older callers that don't set volatileSuffix
  // (and that have not already placed content in stableContext).
  let perTurn =
    sys?.volatileSuffix ??
    (sys?.stableContext ? undefined : sys?.dynamicSuffix);
  if (sys && extra.liveContext) {
    const live = extra.liveContext.trim();
    if (live.length > 0) {
      perTurn = perTurn?.includes("<plan>")
        ? perTurn.replace(/<plan>[\s\S]*?<\/plan>/, () => live)
        : `${perTurn ? `${perTurn}\n\n` : ""}${live}`;
    }
  }
  // Runtime context is harness-injected per-turn state. Append it AFTER the
  // full transcript (including any trailing assistant tool_use + tool_result
  // pair) so:
  //   1) OpenAI/GLM never see a split tool pair (invalid_argument);
  //   2) implicit prefix caches keep hitting on the whole history — only this
  //      trailing note changes between turns.
  // OpenAI keeps demoted runtime as its own trailing user (no merge into the
  // prior turn). Anthropic peels `<runtime_context>` into an uncached system
  // tail so it never rewrites the preceding tool_results user message.
  let effectiveMessages = messages;
  const dynamicSuffix = perTurn;
  if (dynamicSuffix && dynamicSuffix.trim().length > 0) {
    const note = `<runtime_context>\n${dynamicSuffix}\n</runtime_context>`;
    const contextMsg: ProviderMessage = { role: "system", content: [{ type: "text", text: note }] };
    effectiveMessages = messages.length > 0 ? [...messages, contextMsg] : [contextMsg];
  }
  // Wrap-up / tool-lock directive rides a trailing user turn — never folded
  // into runtime_context — so locking tools does not rewrite the cached
  // conversation prefix.
  const trailing = extra.trailingUser?.trim();
  if (trailing) {
    effectiveMessages = [
      ...effectiveMessages,
      { role: "user", content: [{ type: "text", text: trailing }] },
    ];
  }
  void messageId;
  // Either a user Stop (`deps.signal`) or a mid-stream steer (`deps.steerSignal`)
  // cuts the provider SSE. The caller distinguishes them after the stream ends:
  // a steer keeps partial text and re-samples; a Stop ends the run.
  const streamSignal = combineAbortSignals(deps.signal, extra.steerSignal);
  yield* provider.stream({
    model: deps.config.model ?? provider.defaultModel,
    messages: effectiveMessages,
    tools,
    systemPrompt: systemBlock,
    systemPromptBlocks: systemBlocks,
    signal: streamSignal,
    maxTokens: deps.config.maxTokens,
    reasoningEffort: deps.config.reasoningEffort,
    thinkingBudget: deps.config.thinkingBudget,
    promptCacheKey: deps.promptCacheKey,
    responseFormat: deps.responseFormat,
    onRetry: extra.onRetry,
    onRateLimit: extra.onRateLimit,
    toolChoice: extra.toolChoice,
  });
}

/** Combine abort signals so the result aborts when any input aborts. Returns
 * the single defined signal when only one is present, or undefined when none
 * are. */
function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const anyFn = (AbortSignal as unknown as { any?: (s: Iterable<AbortSignal>) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(present);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  for (const s of present) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}
