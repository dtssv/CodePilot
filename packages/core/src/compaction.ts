// Layered compaction:
// 1. Fold old tool_result blocks into a short summary + artifactRef.
// This is a pure local pass — no model call needed.
// 2. If token estimate is still above the threshold, ask the small model
// to summarise the dropped history into a single "compaction" event.
// 3. Plan steps and the most recent N turns are always kept verbatim.

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
 * `./tokens.js` (CJK-aware, code-punctuation-aware, no third-party
 * dependency). */
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

/** Providers bill a downscaled image at roughly 1–1.6K tokens; base64 length
 * says nothing about it. */
const IMAGE_TOKEN_ESTIMATE = 1_600;

export function estimateEventTokens(
  events: Event[],
  estimate: (s: string) => number
): number {
  let total = 0;
  for (const e of events) {
    total += estimate(serializeEventForEstimate(e));
    if ((e.type === "message" || e.type === "tool_result") && e.images) {
      total += e.images.length * IMAGE_TOKEN_ESTIMATE;
    }
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
      if (e.delta.type === "text" || e.delta.type === "reasoning") return e.delta.text;
      return e.delta.partialJson;
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
    case "model":
      return `model:${e.model}${e.providerId ? `@${e.providerId}` : ""}`;
    case "retry":
    case "activity":
    case "subagent":
    case "followup":
      return "";
    case "request":
 // Pure timing metadata — never sent to the provider, so zero cost.
      return "";
    case "team_message":
 // Team chatter is persisted for auditing but never sent to the
 // provider, so it costs zero context. Counting it here would compact
 // early for tokens the model never sees.
      return "";
  }
}

const SUMMARY_TOOL_RESULT_CHARS = 1500;

/** Summariser input: only what the model saw, labelled by role, with very
 * large tool output trimmed (it is in an artifact anyway). Stream deltas,
 * usage and status chatter are noise the summary must not echo. */
function serializeForSummary(e: Event): string {
  switch (e.type) {
    case "message": {
      const text = e.content
        .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `[call ${b.name} ${JSON.stringify(b.input)}]` : ""))
        .filter((s) => s !== "")
        .join("\n");
      return text ? `${e.role.toUpperCase()}: ${text}` : "";
    }
    case "tool_result": {
      const body = e.content.length > SUMMARY_TOOL_RESULT_CHARS
        ? `${e.content.slice(0, SUMMARY_TOOL_RESULT_CHARS)}\n… [${e.content.length - SUMMARY_TOOL_RESULT_CHARS} chars trimmed]`
        : e.content;
      return `RESULT ${e.name}${e.isError ? " (error)" : ""}: ${body}`;
    }
    case "plan":
      return `PLAN: ${e.steps.map((s) => `[${s.status}] ${s.id} ${s.title}`).join("; ")}`;
    case "compaction":
      return `EARLIER SUMMARY:\n${e.summary}`;
    case "error":
      return `ERROR: ${e.message}`;
    default:
      return "";
  }
}

export interface CompactionResult {
  events: Event[];
  summary: string;
  foldedCount: number;
  droppedRange?: { from: number; to: number };
}

export interface FoldOptions {
  keepRecentMessages?: number;
  minChars?: number;
 /** Tool names whose results are folded only after every other eligible
 * result has been folded. File reads are the model's working memory in
 * analysis tasks — folding them early triggers re-read spirals, while
 * bash/grep/glob outputs are usually one-shot listings that summarise
 * well. */
  deferTools?: ReadonlySet<string>;
}

/** Default defer list: reads stay verbatim until nothing else is left. */
export const FOLD_DEFER_TOOLS: ReadonlySet<string> = new Set(["read_file", "read_artifact"]);

/** Pure pass that folds old tool_result content into a short stub + summary. */
export function foldToolResults(
  events: Event[],
  options: FoldOptions = {}
): { events: Event[]; foldedCount: number } {
  const keep = options.keepRecentMessages ?? 8;
 // 1200 chars ≈ a short file read (~30 numbered lines). Anything smaller is
 // almost certainly still useful verbatim; folding it saves little and costs
 // a re-read. The fold-for-budget escalation path lowers this when needed.
  const minChars = options.minChars ?? 1200;
  const defer = options.deferTools ?? FOLD_DEFER_TOOLS;
  const cutoff = findCutoff(events, keep);
  let folded = 0;
 // Pass 1: fold everything except deferred tools. Pass 2 (only when nothing
 // else qualified): fold deferred tools too. This keeps read_file bodies
 // alive as long as there is any bash/grep output left to sacrifice.
  const eligible = (e: Event, allowDeferred: boolean): e is Event & { type: "tool_result" } =>
    e.type === "tool_result" &&
    e.content.length > minChars &&
    !e.content.startsWith("[folded tool_result") &&
    (allowDeferred || !defer.has(e.name));
  let out = events.map((e, idx) => {
    if (idx >= cutoff || !eligible(e, false)) return e;
    folded++;
    return { ...e, content: summariseToolResult(e as Event & { type: "tool_result" }), artifactRef: (e as Event & { type: "tool_result" }).artifactRef ?? undefined };
  });
  if (folded === 0) {
    out = events.map((e, idx) => {
      if (idx >= cutoff || !eligible(e, true)) return e;
      folded++;
      return { ...e, content: summariseToolResult(e as Event & { type: "tool_result" }), artifactRef: (e as Event & { type: "tool_result" }).artifactRef ?? undefined };
    });
  }
  return { events: out, foldedCount: folded };
}

function summariseToolResult(e: Event & { type: "tool_result" }): string {
  const head = e.content.slice(0, 160).replace(/\s+/g, " ");
  const tail = e.content.length > 400
    ? `... [${e.content.length - 240} chars elided] ... ` + e.content.slice(-80).replace(/\s+/g, " ")
    : "";
 // The model must read this as "already done", not as a gap to re-fill —
 // otherwise it re-runs the same read once the original output is folded.
 // Explicitly forbid re-calling the same tool (esp. read_file) — that is
 // the #1 fold-induced doom loop we have observed in real sessions.
  const refetch = e.artifactRef
    ? ` If you truly need the full text again, call read_artifact with ref ${e.artifactRef} — do NOT re-call ${e.name} on the same target.`
    : ` Do NOT re-call ${e.name} for the same target; work from the summary below or ask the user.`;
  return `[folded tool_result of ${e.name} (${e.content.length} chars) — this call already ran and you already saw its output.${refetch}${
    e.artifactRef ? ` artifactRef=${e.artifactRef}` : ""
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
  if (messageIdx.length <= keep) return 0; // nothing to fold
  const cutMessageIdx = messageIdx[messageIdx.length - keep - 1]!;
 // Results after the last assistant message have not been shown to the
 // model yet; folding them would tell it "you already saw this" when it
 // never did.
  const lastAssistant = lastAssistantIndex(events);
  return lastAssistant >= 0 ? Math.min(cutMessageIdx, lastAssistant) : cutMessageIdx;
}

function lastAssistantIndex(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "assistant") return i;
  }
  return -1;
}

/**
 * The structured prompt the small model receives to summarise dropped
 * history. Exported so tests can assert the contract; callers that want
 * to customise the prompt can pass a string override (not currently
 * exposed via the public API but kept here for future use).
 */
export const SUMMARY_SYSTEM_PROMPT = `You are a context compactor for a long-running coding session. The conversation below has been dropped from the active context window because the session is running out of tokens. Your job is to write a summary that will let the next instance of the agent (which has not seen the dropped turns) resume the work as if nothing had happened.

Write the summary in plain text, no markdown code fences, no preamble. Use exactly these seven sections in this order, with a blank line between them. Keep the whole summary under ~1200 tokens; prefer dense prose over lists.

1. USER REQUESTS
   Every request, constraint, correction and preference the user stated, in order. Quote short ones verbatim; condense long ones without dropping any requirement. The work is judged against these.

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

const ARCHIVE_TOOL_RESULT_CHARS = 20_000;

/** Render dropped events as Markdown for the history archive: full message
 * text (a design written in chat must survive verbatim), tool calls, and
 * tool results capped with a pointer to their artifact. */
export function renderTranscriptArchive(events: Event[]): string {
  const blocks: string[] = [];
  const stamp = (e: Event): string => {
    const ts = (e as { ts?: number }).ts;
    return ts ? ` · ${new Date(ts).toISOString()}` : "";
  };
  for (const e of events) {
    switch (e.type) {
      case "message": {
        const text = e.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .filter((s) => s !== "")
          .join("\n");
        const images = e.images?.length ? `\n[${e.images.length} image(s) attached]` : "";
        if (text || images) blocks.push(`### ${e.role.toUpperCase()}${stamp(e)}\n\n${text}${images}`);
        break;
      }
      case "tool_call":
        blocks.push(`### TOOL CALL ${e.name}${stamp(e)}\n\n${JSON.stringify(e.input ?? {})}`);
        break;
      case "tool_result": {
        const ref = e.artifactRef ? ` (artifact ${e.artifactRef})` : "";
        const body =
          e.content.length > ARCHIVE_TOOL_RESULT_CHARS
            ? `${e.content.slice(0, ARCHIVE_TOOL_RESULT_CHARS)}\n… [${e.content.length - ARCHIVE_TOOL_RESULT_CHARS} chars trimmed${e.artifactRef ? `; full text via read_artifact ${e.artifactRef}` : ""}]`
            : e.content;
        blocks.push(`### TOOL RESULT ${e.name}${e.isError ? " (error)" : ""}${ref}${stamp(e)}\n\n${body}`);
        break;
      }
      case "plan":
        blocks.push(`### PLAN\n\n${e.steps.map((s) => `- [${s.status}] ${s.id} ${s.title}`).join("\n")}`);
        break;
      case "compaction":
        blocks.push(`### EARLIER SUMMARY\n\n${e.summary}`);
        break;
      default:
        break;
    }
  }
  return blocks.join("\n\n") + "\n";
}

/**
 * Rebuild the model-facing event list from an append-only transcript.
 * Everything after the last summary compaction (and the tail that
 * compaction kept, identified by `keepFrom`) is live; earlier turns stay
 * on disk only.
 */
export function liveTranscript(persisted: Event[]): Event[] {
  let last = -1;
  for (let i = 0; i < persisted.length; i++) {
    const e = persisted[i]!;
    if (e.type === "compaction" && e.kind !== "micro-fold") last = i;
  }
  if (last < 0) return persisted.slice();
  const c = persisted[last] as Extract<Event, { type: "compaction" }>;
  const keepFrom = typeof c.keepFrom === "number" ? Math.min(Math.max(0, c.keepFrom), last) : last;
  return [c, ...persisted.slice(keepFrom, last), ...persisted.slice(last + 1)];
}

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
    const compactionEvent: Event = { type: "compaction", kind: "summary", summary };
 // The plan is never compacted away: it is what tells the next turn
 // which steps are already done.
    const plan = extractPlan(drop);
    const keepPlan = plan && !recent.some((e) => e.type === "plan");
    working = keepPlan
      ? [compactionEvent, { type: "plan", steps: plan }, ...recent]
      : [compactionEvent, ...recent];
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
  const userContent = events
    .map(serializeForSummary)
    .filter((s) => s !== "")
    .join("\n---\n");
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
