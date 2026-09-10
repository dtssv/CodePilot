// Layered compaction:
//   1. Fold old tool_result blocks into a short summary + artifactRef.
//      This is a pure local pass — no model call needed.
//   2. If token estimate is still above the threshold, ask the small model
//      to summarise the dropped history into a single "compaction" event.
//   3. Plan steps and the most recent N turns are always kept verbatim.

import type {
  ContentBlock,
  Event,
  PlanStep,
  ToolResultBlock,
  ToolUseBlock,
  UsageInfo,
} from "./types.js";
import type { ChatProvider } from "./providers/types.js";
import { estimateTokens as defaultTokenEstimator } from "./tokens.js";

export interface CompactionOptions {
  /** Trigger compaction when total estimated tokens >= this. */
  contextWindow: number;
  /** Number of recent messages to keep verbatim. Default 8. */
  keepRecentMessages?: number;
  /** Token estimator override. Defaults to the segmented estimator in
   *  `./tokens.js` (CJK-aware, code-punctuation-aware, no third-party
   *  dependency). */
  estimateTokens?: (text: string) => number;
  /** When provided, called to summarise (small model path). */
  summariser?: ChatProvider;
  /** Model to use for summarisation. */
  summaryModel?: string;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  estimatedTokens: number;
  reason: string;
}

export function shouldCompact(
  events: Event[],
  opts: CompactionOptions
): CompactionDecision {
  const est = opts.estimateTokens ?? defaultTokenEstimator;
  const tokens = estimateEventTokens(events, est);
  return {
    estimatedTokens: tokens,
    shouldCompact: tokens >= opts.contextWindow,
    reason:
      tokens >= opts.contextWindow
        ? `tokens ${tokens} >= window ${opts.contextWindow}`
        : `tokens ${tokens} < window ${opts.contextWindow}`,
  };
}

export function estimateEventTokens(
  events: Event[],
  estimate: (s: string) => number
): number {
  let total = 0;
  for (const e of events) {
    total += estimate(serializeEventForEstimate(e));
  }
  return total;
}

function serializeEventForEstimate(e: Event): string {
  switch (e.type) {
    case "message":
      return e.content
        .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
        .join("\n");
    case "message_delta":
      return e.delta.type === "text" ? e.delta.text : e.delta.partialJson;
    case "tool_call":
      return JSON.stringify(e.input ?? {});
    case "tool_result":
      return e.content;
    case "plan":
      return JSON.stringify(e.steps);
    case "usage":
      return JSON.stringify(e.usage);
    case "compaction":
      return e.summary;
    case "status":
      return e.status;
    case "error":
      return e.message;
    case "mode":
      return `mode:${e.mode}`;
    case "mode_request":
      return `mode_request:${e.mode}`;
  }
}

export interface CompactionResult {
  events: Event[];
  summary: string;
  foldedCount: number;
  droppedRange?: { from: number; to: number };
}

/** Pure pass that folds old tool_result content into a short stub + summary. */
export function foldToolResults(
  events: Event[],
  options: { keepRecentMessages?: number } = {}
): { events: Event[]; foldedCount: number } {
  const keep = options.keepRecentMessages ?? 8;
  const cutoff = findCutoff(events, keep);
  let folded = 0;
  const out: Event[] = events.map((e, idx) => {
    if (idx >= cutoff) return e;
    if (e.type === "tool_result" && e.content.length > 400) {
      folded++;
      const summary = summariseToolResult(e);
      const foldedBlock: ToolResultBlock = {
        type: "tool_result",
        toolCallId: e.toolCallId,
        content: summary,
        isError: e.isError,
        artifactRef: e.artifactRef,
      };
      return { ...e, content: summary, artifactRef: e.artifactRef ?? undefined };
    }
    return e;
  });
  return { events: out, foldedCount: folded };
}

function summariseToolResult(e: Event & { type: "tool_result" }): string {
  const head = e.content.slice(0, 200).replace(/\s+/g, " ");
  const tail = e.content.length > 400
    ? `... [${e.content.length - 200} chars elided] ... ` + e.content.slice(-100).replace(/\s+/g, " ")
    : "";
  return `[folded tool_result (${e.content.length} chars)${
    e.artifactRef ? `, artifact ${e.artifactRef}` : ""
  }]\n${head}${tail}`;
}

function findCutoff(events: Event[], keep: number): number {
  // Find the index such that everything before it may be folded.
  // We count "messages" (not events) — i.e. message/tool_call/tool_result triples
  // for a single assistant turn count as 1.
  const messageIdx: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "user") messageIdx.push(i);
    else if (e.type === "message" && e.role === "assistant") messageIdx.push(i);
  }
  if (messageIdx.length <= keep) return events.length; // nothing to fold
  const cutMessageIdx = messageIdx[messageIdx.length - keep - 1];
  return cutMessageIdx;
}

/**
 * The structured prompt the small model receives to summarise dropped
 * history. Exported so tests can assert the contract; callers that want
 * to customise the prompt can pass a string override (not currently
 * exposed via the public API but kept here for future use).
 */
export const SUMMARY_SYSTEM_PROMPT = `You are a context compactor for a long-running coding session. The conversation below has been dropped from the active context window because the session is running out of tokens. Your job is to write a summary that will let the next instance of the agent (which has not seen the dropped turns) resume the work as if nothing had happened.

Write the summary in plain text, no markdown code fences, no preamble. Use exactly these seven sections in this order, with a blank line between them. Keep the whole summary under ~1200 tokens; prefer dense prose over lists.

1. TASK OVERVIEW
   The user's request, success criteria, and any clarifications they gave. One or two sentences.

2. CURRENT STATE
   What is done, what is in flight, and what is not started. Reference plan step ids when present.

3. KEY FILES AND SYMBOLS
   Concrete paths and line numbers the next agent will need: files read, files edited, exported symbols touched, config knobs flipped. Format: \`path/to/file.ts:42 — why it matters\`.

4. DECISIONS MADE
   Choices the team (or the previous agent) took, with the one-sentence rationale. Anything that, if forgotten, would cause the next agent to re-debate it.

5. ERRORS AND FIXES
   Bugs hit, their root cause, and how they were resolved. Include the verbatim command or error message when it is diagnostic (e.g. a specific stack-trace frame). Skip transient network blips.

6. OPEN THREADS
   Things left unfinished, known unknowns, and any questions waiting on the user.

7. NEXT CONCRETE ACTION
   The single most useful thing the next agent should do first. One sentence.

Rules:
- Preserve verbatim: exact command lines, file paths, error messages, env var values, branch names, commit hashes, and any literal string the user gave (connection strings, ports, seeds, tokens). Never paraphrase these.
- Drop: conversational filler, duplicate tool outputs, intermediate reasoning that did not lead to a decision.
- When in doubt about whether something is verbatim-form, treat it as verbatim and quote it.
- Do not address the user. Do not say "I". Do not add a closing line. The seven sections are the entire output.`;

/**
 * Run the full layered compaction. If no summariser is provided only the
 * local fold pass is applied. The result is a new event list with a
 * synthetic compaction event prepended (if anything was dropped).
 */
export async function compact(
  events: Event[],
  opts: CompactionOptions
): Promise<CompactionResult> {
  const decision = shouldCompact(events, opts);
  if (!decision.shouldCompact) {
    return { events, summary: "", foldedCount: 0 };
  }

  // Pass 1: local folding of old tool results.
  const folded = foldToolResults(events, { keepRecentMessages: opts.keepRecentMessages });
  let working = folded.events;

  // Pass 2: model-driven summary if still over budget.
  if (
    opts.summariser &&
    estimateEventTokens(working, opts.estimateTokens ?? defaultTokenEstimator) >=
      opts.contextWindow
  ) {
    const cutoff = findCutoff(working, opts.keepRecentMessages ?? 8);
    const drop = working.slice(0, cutoff);
    const recent = working.slice(cutoff);
    const summary = await callSummariser(opts.summariser, drop, opts.summaryModel);
    const compactionEvent: Event = { type: "compaction", summary };
    working = [compactionEvent, ...recent];
    return {
      events: working,
      summary,
      foldedCount: folded.foldedCount,
      droppedRange: { from: 0, to: cutoff },
    };
  }

  return { events: working, summary: "", foldedCount: folded.foldedCount };
}

async function callSummariser(
  provider: ChatProvider,
  events: Event[],
  model: string | undefined
): Promise<string> {
  const userContent = events.map(serializeEventForEstimate).join("\n---\n");
  const collected: string[] = [];
  const stream = provider.stream({
    model: model ?? provider.smallModel,
    messages: [{ role: "user", content: [{ type: "text", text: userContent }] }],
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
  });
  for await (const ev of stream) {
    if (ev.kind === "text_delta") collected.push(ev.text);
    if (ev.kind === "error") throw new Error(ev.message);
  }
  return collected.join("").trim() || "(no summary produced)";
}

/** Decide whether a usage update means compaction should run. */
export function usageSignalsCompact(usage: UsageInfo, window: number): boolean {
  return (usage.input ?? 0) >= window;
}

/** Internal helper used by session — extract the most recent plan. */
export function extractPlan(events: Event[]): PlanStep[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "plan") return e.steps;
  }
  return undefined;
}

/** Map Event list back to provider-friendly messages, applying folds. */
export function eventsToMessages(
  events: Event[]
): { role: "user" | "assistant" | "system"; content: ContentBlock[] }[] {
  // Merge message_deltas back into the parent message where present.
  // We walk the events linearly and keep the latest `message` plus its
  // tool_call + tool_result sequence.
  const out: { role: "user" | "assistant" | "system"; content: ContentBlock[] }[] = [];
  type MessageEvent = Extract<Event, { type: "message" }>;
  let pending: MessageEvent | null = null;

  for (const e of events) {
    if (e.type === "message") {
      // If we have a previous user/assistant message, flush it.
      if (pending) {
        out.push({
          role: pending.role,
          content: pending.content,
        });
      }
      pending = e;
      continue;
    }
    if (e.type === "message_delta") {
      // Apply delta to the pending assistant message.
      if (pending && pending.role === "assistant") {
        if (e.delta.type === "text") {
          const last: ContentBlock | undefined = pending.content[pending.content.length - 1];
          if (last && last.type === "text") {
            pending = {
              ...pending,
              content: [
                ...pending.content.slice(0, -1),
                { type: "text", text: last.text + e.delta.text },
              ],
            };
          } else {
            pending = {
              ...pending,
              content: [...pending.content, { type: "text", text: e.delta.text }],
            };
          }
        }
        // tool_input_json delta: represented by the eventual tool_call event.
      }
      continue;
    }
    if (e.type === "tool_call") {
      const t: ToolUseBlock = { type: "tool_use", id: e.id, name: e.name, input: e.input };
      if (pending && pending.role === "assistant") {
        pending = {
          ...pending,
          content: [...pending.content, t],
        };
      } else {
        out.push({
          role: "assistant",
          content: [t],
        });
      }
      continue;
    }
    if (e.type === "tool_result") {
      const r: ToolResultBlock = {
        type: "tool_result",
        toolCallId: e.toolCallId,
        content: e.content,
        isError: e.isError,
        artifactRef: e.artifactRef,
      };
      // Push as its own user-style message so providers see it in order.
      out.push({
        role: "user",
        content: [r],
      });
      continue;
    }
    if (e.type === "compaction") {
      out.push({
        role: "user",
        content: [
          { type: "text", text: `[Earlier conversation summary]\n${e.summary}` },
        ],
      });
      continue;
    }
    // Other event types (plan/usage/status/error) are skipped from the
    // provider-facing transcript; the agent loop handles them separately.
  }
  if (pending) {
    out.push({ role: pending.role, content: pending.content });
  }
  return out;
}
