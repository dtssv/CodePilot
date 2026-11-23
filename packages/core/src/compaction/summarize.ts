// Summarisation, transcript views, and hard-trim compaction pipeline.

import {
  normalizePlanStepStatus,
  type Event,
  type PlanStep,
} from "../types.js";
import type { ChatProvider } from "../providers/types.js";
import { estimateTokens as defaultTokenEstimator } from "./tokens.js";
import {
  shouldCompact,
  estimateEventTokens,
  FORCED_SHRINK_RATIO,
} from "./geometry.js";
import { foldToolResults, findCutoff, type CompactionResult } from "./fold.js";
import { applyToolResultPruneOverlays } from "./prune.js";
import { truncateToolCallInput } from "./toolInput.js";
import type { CompactionOptions } from "./geometry.js";

/** Error tool_results keep a short diagnostic head for Errors;
 * successful bodies are omitted. */
const SUMMARY_ERROR_RESULT_CHARS = 400;

type ToolCallMeta = { name: string; target?: string };

/** Pull a path/pattern/query from tool_use input for summary stubs. */
function toolCallTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "glob", "pattern", "query", "url", "command"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      // Commands can be long — keep a short head for the stub only.
      return key === "command" && v.length > 120 ? `${v.slice(0, 120)}…` : v;
    }
  }
  return undefined;
}

function collectToolCallMeta(events: Event[]): Map<string, ToolCallMeta> {
  const meta = new Map<string, ToolCallMeta>();
  for (const e of events) {
    if (e.type !== "message") continue;
    for (const b of e.content) {
      if (b.type !== "tool_use") continue;
      meta.set(b.id, { name: b.name, target: toolCallTarget(b.input) });
    }
  }
  return meta;
}

/** Summariser input for one event. Tool bodies are stubbed (paths/meta only)
 * so the checkpoint does not paste read_file/code dumps. */
export function serializeForSummary(
  e: Event,
  callMeta: Map<string, ToolCallMeta> = new Map(),
): string {
  switch (e.type) {
    case "message": {
      const text = e.content
        .map((b) =>
          b.type === "text"
            ? b.text
            : b.type === "tool_use"
              ? `[call ${b.name} ${JSON.stringify(truncateToolCallInput(b.input))}]`
              : "",
        )
        .filter((s) => s !== "")
        .join("\n");
      return text ? `${e.role.toUpperCase()}: ${text}` : "";
    }
    case "tool_result": {
      const meta = callMeta.get(e.toolCallId);
      const target = meta?.target;
      const targetBit = target ? ` target=${JSON.stringify(target)}` : "";
      const refBit = e.artifactRef ? ` artifact=${e.artifactRef}` : "";
      if (e.isError) {
        const head =
          e.content.length > SUMMARY_ERROR_RESULT_CHARS
            ? `${e.content.slice(0, SUMMARY_ERROR_RESULT_CHARS)}…`
            : e.content;
        return `RESULT ${e.name} (error)${targetBit}${refBit}: ${head.replace(/\s+/g, " ").trim()}`;
      }
      // Success: omit body entirely — next agent re-reads paths as needed.
      return `RESULT ${e.name}${targetBit}${refBit} (${e.content.length} chars) [body omitted — re-read if needed]`;
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

/** Full transcript text fed to the summariser model. */
export function serializeEventsForSummary(events: Event[]): string {
  const callMeta = collectToolCallMeta(events);
  return events
    .map((e) => serializeForSummary(e, callMeta))
    .filter((s) => s !== "")
    .join("\n---\n");
}
/**
 * Handoff checkpoint prompt. Fixed section order (goals → concepts → files →
 * errors → done → pending → current → next → critical) so a resuming agent can
 * find open work without pasted code.
 */
export const SUMMARY_SYSTEM_PROMPT = `You are writing a handoff checkpoint so another coding agent can continue this session without the dropped turns.

Output ONLY the Markdown below. No preamble, no closing line, no tool calls, no mention that context was compacted. Do not address the user and do not say "I". Keep every section (use "(none)" when empty). Terse single-line bullets. Whole checkpoint under ~900 tokens.

## Goals
- Every distinct user request, correction, and hard constraint for this work, in order. Quote exact wording when it matters.
- Do not drop an earlier goal because a later message refined it — keep both if both still apply.
- If the user said what "done" looks like, one short line for that.

## Concepts
- Technologies, frameworks, patterns, and conventions in play — or "(none)".
- One-line each; no code dumps.

## Key files
- \`path/to/file.ts:42 — why it matters\` (at most ~15). Include examined, edited, or created paths.
- Paths + why only — NEVER paste file contents, diffs, or tool output.

## Errors
- Each error or failure hit, how it was fixed (or that it is still open), plus related user feedback — or "(none)".
- Prefer verbatim error strings / commands when diagnostic.

## Done
- Finished work and verified outcomes — or "(none)".
- When a plan exists, list every \`[completed]\` step as \`[completed] id — title\`.
- Include consequential git state when relevant (uncommitted / committed / pushed).

## Pending
- Explicitly requested work not yet started — or "(none)".
- When a plan exists, list every \`[pending]\` step as \`[pending] id — title\`. Also list unfinished user asks that are not started.

## Current
- Precisely what is in flight at this checkpoint — or "(none)".
- When a plan exists, list every \`[in_progress]\` step as \`[in_progress] id — title\`, plus partial edits and open questions waiting on the user (exact wording).
- Do not put completed work here — that belongs in Done.

## Up next
1. The single next action that continues the user's most recent explicit ask (prefer the next incomplete plan step id, or file:line) — or "(none)".
2. Optional follow-up if already clear — or "(none)".

## Critical
- Decisions and one-line why (what was picked over what).
- Constraints, preferences, open questions, traps/gotchas, and identifiers needed to continue.
- One-line facts only (e.g. \`FooService\` exports \`bar\`). Or "(none)" if empty.

Rules:
- Keep every section, even when empty; never drop a section.
- Terse bullets, not prose paragraphs.
- Preserve verbatim: file paths, commands, error strings, URLs, identifiers, env values, branch/commit names, and user-supplied literals. Never paraphrase those.
- NEVER paste file contents, diffs, or tool bodies. Transcript tool results are stubbed on purpose — record path + one-line takeaway; re-read if exact text is needed. Do not invent code.
- Distinguish verified from assumed: tool-backed facts (read/grep/test) state plainly; unaided agent claims mark as "assumed"/"unverified".
- Source separation: do not merge topics from an earlier distinct task into the current one.
- If an earlier checkpoint appears in the history: keep still-true facts, drop stale ones, merge newer progress; move finished Current items into Done; where they conflict, the newer conversation wins.
- Up next must stay aligned with the latest user request — do not invent a new task.`;

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
        blocks.push(
          `### TOOL CALL ${e.name}${stamp(e)}\n\n${JSON.stringify(truncateToolCallInput(e.input ?? {}))}`,
        );
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
 * Rebuild the model-facing event list from an append-only transcript: keep
 * everything after the last summary compaction (plus the tail `keepFrom`).
 */
export function liveTranscript(persisted: Event[]): Event[] {
  const hidden = rewoundIndices(persisted);
  const visible = (_: Event, i: number): boolean => !hidden.has(i);
  let last = -1;
  for (let i = 0; i < persisted.length; i++) {
    const e = persisted[i]!;
    if (e.type === "compaction" && e.kind !== "micro-fold" && !hidden.has(i)) last = i;
  }
  let live: Event[];
  if (last < 0) {
    live = hidden.size === 0 ? persisted.slice() : persisted.filter(visible);
  } else {
    const c = persisted[last] as Extract<Event, { type: "compaction" }>;
    const keepFrom = typeof c.keepFrom === "number" ? Math.min(Math.max(0, c.keepFrom), last) : last;
    const keep = (from: number, to: number) =>
      persisted.slice(from, to).filter((e, j) => !hidden.has(from + j));
    live = [c, ...keep(keepFrom, last), ...keep(last + 1, persisted.length)];
  }
  // Apply durable micro-fold stubs so resume and estimates see the same
  // pruned bodies the next provider request will send.
  return applyToolResultPruneOverlays(live);
}

/** Indices hidden by `rewind` events: each hides the span from the message it
 * names through the rewind event itself. A compaction inside a hidden span is
 * void, so the model view falls back to the pre-compaction transcript. */
export function rewoundIndices(persisted: Event[]): Set<number> {
  const hidden = new Set<number>();
  const firstIndex = new Map<string, number>();
  for (let i = 0; i < persisted.length; i++) {
    const e = persisted[i]!;
    if (e.type === "message" && !firstIndex.has(e.id)) firstIndex.set(e.id, i);
    if (e.type !== "rewind") continue;
    const from = firstIndex.get(e.toMessageId);
    if (from === undefined || from > i) continue;
    for (let j = from; j <= i; j++) hidden.add(j);
  }
  return hidden;
}

/** The displayed history: the full log minus rewound spans (compacted turns
 * stay visible — only a rewind removes turns from the UI). */
export function visibleHistory(persisted: Event[]): Event[] {
  const hidden = rewoundIndices(persisted);
  return hidden.size === 0 ? persisted.slice() : persisted.filter((_, i) => !hidden.has(i));
}

/**
 * Hard-trim a transcript copy to fit `budget` tokens (never mutates input):
 * fold tool_results over dropping turns; when turns drop, replace with a
 * structured handoff. Keep latest plan + last user turn and everything after.
 */
export function trimEventsToBudget(
  events: Event[],
  budget: number,
  opts: {
    keepRecentMessages?: number;
    estimateTokens?: (text: string) => number;
  } = {},
): { events: Event[]; trimmed: boolean; foldedCount: number } {
  const est = opts.estimateTokens ?? defaultTokenEstimator;
  const initialKeep = opts.keepRecentMessages ?? 8;
  if (budget <= 0) return { events: events.slice(), trimmed: false, foldedCount: 0 };

  let foldedCount = 0;
  let trimmed = false;
  let working = events;
  const over = (): boolean => estimateEventTokens(working, est) > budget;

  // Never shrink the keep window below 2 (≈ last user + reply): dropping the
  // active user request is the #1 cause of post-compact task derailment.
  for (const keep of uniqueDescending([initialKeep, 6, 4, 2]).filter((k) => k >= 2)) {
    if (!over()) break;
    const folded = foldToolResults(working, {
      keepRecentMessages: keep,
      minChars: keep <= 4 ? 80 : 160,
    });
    working = folded.events;
    foldedCount += folded.foldedCount;
    if (folded.foldedCount > 0) trimmed = true;

    let guard = 0;
    while (over() && guard++ < 32) {
      const rawCutoff = findCutoff(working, keep);
      const lastUser = findLastUserMessageIndex(working);
      // Do not cut into the last user turn (or anything after it).
      const cutoff =
        lastUser >= 0 ? Math.min(rawCutoff, lastUser) : rawCutoff;
      if (cutoff <= 0) break;
      const drop = working.slice(0, cutoff);
      const recent = working.slice(cutoff);
      const priorSummary =
        working[0]?.type === "compaction" && working[0].kind === "summary"
          ? working[0].summary
          : undefined;
      // Exclude prior compaction blobs from re-extraction — they'd explode the
      // stub. Semantics come from a capped merge of prior head + fresh handoff.
      const dropSansCompaction = drop.filter((e) => e.type !== "compaction");
      // Cap the stub relative to the remaining budget so the handoff itself
      // cannot consume the whole window (esp. tiny test / small-model budgets).
      const stubCharCap = Math.min(
        HANDOFF_MAX_CHARS,
        Math.max(500, Math.floor(budget * 2)),
      );
      const stub: Event = {
        type: "compaction",
        kind: "summary",
        summary: buildTrimStub(priorSummary, dropSansCompaction, stubCharCap),
      };
      const plan = extractPlan(drop) ?? extractPlan(recent);
      const recentHasPlan = recent.some((e) => e.type === "plan");
      const recentClean =
        recent[0]?.type === "compaction" ? recent.slice(1) : recent;
      // Pinned messages in the dropped range are carried verbatim after the
      // handoff stub — a pinned user requirement survives every trim intact.
      const carriedPins = drop.filter(
        (e): e is Extract<Event, { type: "message" }> =>
          e.type === "message" && e.pinned === true,
      );
      working =
        plan && !recentHasPlan
          ? [stub, ...carriedPins, { type: "plan", steps: plan }, ...recentClean]
          : [stub, ...carriedPins, ...recentClean];
      trimmed = true;
    }

    if (over()) {
      const stripped = stripOlderImages(working, keep);
      if (stripped.removed > 0) {
        working = stripped.events;
        trimmed = true;
      }
    }
  }

  if (over()) {
    // Still over: fold even inside the protected tail (tool dumps only).
    const folded = foldToolResults(working, {
      keepRecentMessages: 1,
      minChars: 80,
    });
    working = folded.events;
    foldedCount += folded.foldedCount;
    if (folded.foldedCount > 0) trimmed = true;
  }

  if (over()) {
    const shrunk = truncateOversizedPayloads(working, budget, est);
    if (shrunk.changed) {
      working = shrunk.events;
      trimmed = true;
    }
  }

  return { events: working, trimmed, foldedCount };
}

function uniqueDescending(nums: number[]): number[] {
  return [...new Set(nums.map((n) => Math.max(0, Math.floor(n))))].sort((a, b) => b - a);
}

function findLastUserMessageIndex(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "user") return i;
  }
  return -1;
}

const HANDOFF_MAX_CHARS = 4_000;
const PRIOR_HANDOFF_HEAD = 1_800;

function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Merge a prior summary head with a fresh handoff, hard-capped so repeated
 * trims cannot explode the stub (that itself would defeat compression). */
function buildTrimStub(
  prior: string | undefined,
  dropped: Event[],
  maxChars: number = HANDOFF_MAX_CHARS,
): string {
  const handoff = buildLocalHandoffSummary(dropped, maxChars);
  if (!prior?.trim()) return handoff;
  const priorHead = capText(prior.trim(), Math.min(PRIOR_HANDOFF_HEAD, Math.floor(maxChars / 3)));
  // Prefer the newer handoff body; keep prior only as a short prefix so
  // earlier Goals / Critical are not lost entirely.
  return capText(`${priorHead}\n\n---\nLater trim:\n${handoff}`, maxChars);
}

/**
 * Deterministic handoff when turns are dropped without an LLM summariser.
 * Same section shape as SUMMARY_SYSTEM_PROMPT so resume UX stays consistent.
 */
export function buildLocalHandoffSummary(
  dropped: Event[],
  maxChars: number = HANDOFF_MAX_CHARS,
): string {
  const userAsks: string[] = [];
  const files = new Set<string>();
  const errors: string[] = [];
  const decisions: string[] = [];
  const askCap = Math.min(500, Math.max(120, Math.floor(maxChars / 6)));

  for (const e of dropped) {
    if (e.type === "message" && e.role === "user") {
      const text = e.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      if (
        text &&
        !text.startsWith("[Earlier conversation summary]") &&
        !text.startsWith("HANDOFF") &&
        !text.startsWith("## Goals") &&
        !text.startsWith("## Concepts")
      ) {
        userAsks.push(text.length > askCap ? `${text.slice(0, askCap)}…` : text);
      }
    }
    if (e.type === "message" && e.role === "assistant") {
      const text = e.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      if (text && text.length < 400 && /(?:^|\n)(?:I(?:'ll| will)|Next|Going to|Plan:)/i.test(text)) {
        decisions.push(text.length > 240 ? `${text.slice(0, 240)}…` : text);
      }
    }
    if (e.type === "tool_call") {
      const inp = e.input as Record<string, unknown> | undefined;
      const path = inp?.path;
      if (typeof path === "string" && path.length > 0) files.add(path);
      const command = inp?.command;
      if (typeof command === "string" && /(?:npm|pnpm|yarn|pytest|cargo|go test|make)\b/i.test(command)) {
        decisions.push(`ran: ${command.length > 160 ? `${command.slice(0, 160)}…` : command}`);
      }
    }
    if (e.type === "tool_result" && e.isError) {
      const head = e.content.slice(0, 220).replace(/\s+/g, " ");
      errors.push(`${e.name}: ${head}`);
    }
  }

  const plan = extractPlan(dropped);
  // Keep several user asks — original goal + later corrections both matter.
  const objective =
    userAsks.length > 0
      ? userAsks.slice(-4).map((u) => `- ${u}`).join("\n")
      : "- (none)";
  const details: string[] = [];
  for (const d of decisions.slice(-8)) details.push(`- ${d}`);
  if (details.length === 0) details.push("- (none)");

  const fmtStep = (s: { status: string; id: string; title: string }) =>
    `- [${s.status}] ${s.id} — ${s.title}`;
  const completed =
    plan && plan.length > 0
      ? plan.filter((s) => s.status === "completed").map(fmtStep)
      : [];
  const inProgress =
    plan && plan.length > 0
      ? plan.filter((s) => s.status === "in_progress").map(fmtStep)
      : [];
  const pending =
    plan && plan.length > 0
      ? plan.filter((s) => s.status === "pending").map(fmtStep)
      : [];
  const errorLines = errors.slice(-6).map((err) => `- ${err}`);
  const nextPlan =
    plan?.find((s) => s.status === "in_progress") ??
    plan?.find((s) => s.status === "pending");

  const sections = [
    "## Goals",
    objective,
    "",
    "## Concepts",
    "- (none)",
    "",
    "## Key files",
    ...(files.size > 0
      ? [...files].slice(-15).map((p) => `- \`${p}\` — touched in dropped turns`)
      : ["- (none)"]),
    "",
    "## Errors",
    ...(errorLines.length > 0 ? errorLines : ["- (none)"]),
    "",
    "## Done",
    ...(completed.length > 0 ? completed : ["- (none)"]),
    "",
    "## Pending",
    ...(pending.length > 0 ? pending : ["- (none)"]),
    "",
    "## Current",
    ...(inProgress.length > 0 ? inProgress : ["- (none)"]),
    "",
    "## Up next",
    nextPlan
      ? `1. Continue plan step \`${nextPlan.id}\` — ${nextPlan.title}.`
      : "1. Continue from the recent turns below; re-read files if exact text is needed.",
    "2. (none)",
    "",
    "## Critical",
    ...(details[0] === "- (none)" ? ["- (none)"] : details),
  ];
  return capText(sections.join("\n"), maxChars);
}

/**
 * Shrink oversized payloads until under budget. Prefer tool dumps; never
 * truncate the latest user message or plan events.
 */
function truncateOversizedPayloads(
  events: Event[],
  budget: number,
  est: (s: string) => number,
): { events: Event[]; changed: boolean } {
  let working = events.slice();
  let changed = false;
  let guard = 0;
  const lastUser = findLastUserMessageIndex(working);

  while (estimateEventTokens(working, est) > budget && guard++ < 48) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < working.length; i++) {
      const e = working[i]!;
      const len = payloadLen(e);
      if (len < 80) continue;
      const pri = truncationPriority(e, i, lastUser);
      if (pri < 0) continue;
      const score = pri * 1_000_000 + len;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const e = working[bestIdx]!;
    const len = payloadLen(e);
    // Shrink aggressively when far over budget; floor at 80 so dumps can
    // keep collapsing across iterations.
    const keepChars = Math.max(80, Math.floor(len / 2));
    if (e.type === "tool_result") {
      // Fold stubs are already non-semantic dumps — collapse to a one-liner.
      if (e.content.startsWith("[folded tool_result")) {
        working[bestIdx] = {
          ...e,
          content: e.artifactRef
            ? `[folded ${e.name} — already seen; read_artifact ${e.artifactRef} if needed]`
            : `[folded ${e.name} — already seen; do not re-call]`,
        };
        changed = true;
        continue;
      }
      const refHint = e.artifactRef
        ? ` Full text: read_artifact ${e.artifactRef}.`
        : " Re-run only if you still need the omitted bytes.";
      const notice = `\n… [truncated to fit context window.]${refHint}\n`;
      const bodyBudget = Math.max(40, keepChars - notice.length);
      const head = Math.floor(bodyBudget * 0.7);
      const tail = Math.max(0, bodyBudget - head);
      working[bestIdx] = {
        ...e,
        content:
          e.content.slice(0, head) +
          notice +
          (tail > 0 ? e.content.slice(-tail) : ""),
      };
      changed = true;
    } else if (e.type === "message" && e.role === "assistant") {
      working[bestIdx] = {
        ...e,
        content: e.content.map((b) =>
          b.type === "text" && b.text.length > keepChars
            ? {
                ...b,
                text:
                  b.text.slice(0, keepChars) +
                  `\n… [assistant text truncated to fit context window]`,
              }
            : b,
        ),
      };
      changed = true;
    } else if (e.type === "compaction" && e.summary.length > 200) {
      // Keep the head (Goals / Pending / Current / files) — drop the tail first.
      working[bestIdx] = {
        ...e,
        summary:
          capText(e.summary, keepChars).replace(/…$/, "") +
          "\n… [handoff truncated; recent turns below are authoritative]",
      };
      changed = true;
    } else if (e.type === "message" && e.role === "user" && iIsOldUser(bestIdx, lastUser)) {
      // Only ancient user turns, and only when nothing else will shrink.
      working[bestIdx] = {
        ...e,
        content: e.content.map((b) =>
          b.type === "text" && b.text.length > keepChars
            ? {
                ...b,
                text:
                  b.text.slice(0, keepChars) +
                  `\n… [earlier user message truncated — see HANDOFF Goals]`,
              }
            : b,
        ),
      };
      changed = true;
    } else {
      break;
    }
  }
  return { events: working, changed };
}

function iIsOldUser(idx: number, lastUser: number): boolean {
  return lastUser < 0 || idx < lastUser;
}

function payloadLen(e: Event): number {
  if (e.type === "tool_result") return e.content.length;
  if (e.type === "compaction") return e.summary.length;
  if (e.type === "message") {
    return e.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
  }
  return 0;
}

/** Higher = safer to shrink. Negative = protected. */
function truncationPriority(e: Event, idx: number, lastUser: number): number {
  if (e.type === "plan") return -1;
  // A pinned message is protected from payload truncation outright.
  if (e.type === "message" && e.pinned) return -1;
  if (e.type === "message" && e.role === "user") {
    if (idx >= lastUser && lastUser >= 0) return -1;
    return 1; // old user asks — last resort only
  }
  if (e.type === "tool_result") {
    // Fold stubs are safe to collapse further (artifactRef retained in text).
    if (e.content.startsWith("[folded tool_result")) return 11;
    if (e.name === "bash" || e.name === "grep" || e.name === "glob") return 10;
    if (e.name === "read_file" || e.name === "read_artifact") return 8;
    return 7;
  }
  if (e.type === "message" && e.role === "assistant") return 5;
  if (e.type === "compaction") return 3;
  return 0;
}

/** Drop image attachments on events before the recent cutoff (text remains). */
function stripOlderImages(
  events: Event[],
  keepMessages: number,
): { events: Event[]; removed: number } {
  const cutoff = findCutoff(events, keepMessages);
  if (cutoff <= 0) return { events, removed: 0 };
  let removed = 0;
  const out = events.map((e, idx) => {
    if (idx >= cutoff) return e;
    // A pinned message keeps its images too (the anchor is kept intact).
    if (e.type === "message" && e.pinned) return e;
    if ((e.type === "message" || e.type === "tool_result") && e.images?.length) {
      removed += e.images.length;
      return { ...e, images: undefined };
    }
    return e;
  });
  return { events: out, removed };
}

/**
 * Run the full layered compaction. If no summariser is provided only the
 * local fold + hard-trim passes run. The result is a new event list with a
 * synthetic compaction event prepended (if anything was dropped).
 */
export async function compact(
  events: Event[],
  opts: CompactionOptions
): Promise<CompactionResult> {
  const decision = shouldCompact(events, opts);
  if (!opts.force && !decision.shouldCompact) {
    return { events, summary: "", foldedCount: 0 };
  }

  const est = opts.estimateTokens ?? defaultTokenEstimator;
  const keep = opts.keepRecentMessages ?? 8;
  // Forced runs (API already over window) must aim well below the trigger;
  // otherwise the under-counting estimator thinks we're "fine" and drops nothing.
  const target = opts.force
    ? Math.min(opts.contextWindow, Math.max(8_000, Math.floor(opts.contextWindow * FORCED_SHRINK_RATIO)))
    : opts.contextWindow;

 // Pass 1: local folding of old tool results.
  const folded = foldToolResults(events, { keepRecentMessages: keep });
  let working = folded.events;
  let droppedRange: { from: number; to: number } | undefined;
  let summary = "";

 // Pass 2: model-driven summary if still over budget.
  if (
    opts.summariser &&
    (opts.force || estimateEventTokens(working, est) >= target)
  ) {
    const cutoff = findCutoff(working, keep);
    if (cutoff > 0) {
      const drop = working.slice(0, cutoff);
      const recent = working.slice(cutoff);
      try {
        summary = await callSummariser(opts.summariser, drop, opts.summaryModel, opts.extraInstructions);
      } catch {
        summary = "";
      }
      // Forward-progress gate: only adopt the summary when it genuinely shrinks
      // the dropped range — a degenerate summary (verbose restatement) would
      // make compaction a no-op/regression and persist a bloated blob. Otherwise
      // discard it and let Pass 3's hard local trim guarantee we fit.
      if (summary) {
        const compactionEvent: Event = { type: "compaction", kind: "summary", summary };
        const plan = extractPlan(drop);
        const keepPlan = plan && !recent.some((e) => e.type === "plan");
        const replacement = keepPlan
          ? [compactionEvent, { type: "plan", steps: plan } as Event]
          : [compactionEvent];
        const droppedTokens = estimateEventTokens(drop, est);
        const replacementTokens = estimateEventTokens(replacement, est);
        if (replacementTokens < droppedTokens) {
          working = [...replacement, ...recent];
          droppedRange = { from: 0, to: cutoff };
        } else {
          // Non-shrinking summary: treat it as a failed summarisation so the
          // reason/return value don't claim a summary that wasn't applied.
          summary = "";
        }
      }
    }
  }

 // Pass 3: hard local trim so we never leave the caller over budget.
 // Runs when summariser was absent, failed, or the summary alone was
 // not enough.
  if (opts.force || estimateEventTokens(working, est) >= target) {
    const hard = trimEventsToBudget(working, Math.max(1, target - 1), {
      keepRecentMessages: keep,
      estimateTokens: est,
    });
    working = hard.events;
    if (hard.trimmed && !summary) {
      const head = working.find((e) => e.type === "compaction");
      summary = head && head.type === "compaction" ? head.summary : "";
    }
  }

  return {
    events: working,
    summary,
    foldedCount: folded.foldedCount,
    droppedRange,
  };
}

async function callSummariser(
  provider: ChatProvider,
  events: Event[],
  model: string | undefined,
  extraInstructions?: string,
): Promise<string> {
  const userContent = serializeEventsForSummary(events);
  const collected: string[] = [];
  const systemPrompt = composeSummaryPrompt(extraInstructions);
  const stream = provider.stream({
    model: model ?? provider.smallModel,
    messages: [{ role: "user", content: [{ type: "text", text: userContent }] }],
    systemPrompt,
  });
  for await (const ev of stream) {
    if (ev.kind === "text_delta") collected.push(ev.text);
    if (ev.kind === "error") throw new Error(ev.message);
  }
  return collected.join("").trim() || "(no summary produced)";
}

/** Compose the summariser system prompt: the base checkpoint spec plus an
 * optional, clearly-delimited "Additional Instructions" block carrying the
 * user's compact instructions (what the summary MUST preserve). */
export function composeSummaryPrompt(extraInstructions?: string): string {
  const extra = (extraInstructions ?? "").trim();
  if (extra.length === 0) return SUMMARY_SYSTEM_PROMPT;
  return (
    SUMMARY_SYSTEM_PROMPT +
    "\n\n## Additional Instructions\n" +
    "The user has explicitly asked that the summary preserve the following. " +
    "Treat these as hard requirements and do not drop them:\n\n" +
    extra
  );
}

/**
 * Merge compact instructions from three sources (project → focus → hook) into
 * one block; later sources are appended, not erased. Blank sources are skipped
 * and exact duplicates collapsed. Returns undefined when nothing was supplied.
 */
export function mergeCompactInstructions(sources: {
  project?: string;
  focus?: string;
  hook?: string;
}): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of [sources.project, sources.focus, sources.hook]) {
    const trimmed = (raw ?? "").trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push(trimmed);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Internal helper used by session — extract the most recent plan. */
export function extractPlan(events: Event[]): PlanStep[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "plan") {
      // Coerce legacy `blocked` (and any unknown) so resumed JSONL stays valid.
      return e.steps.map((s) => ({
        ...s,
        status: normalizePlanStepStatus(s.status as string),
      }));
    }
  }
  return undefined;
}

