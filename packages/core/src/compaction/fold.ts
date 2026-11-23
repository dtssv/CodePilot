// Local tool-result folding (no LLM).

import type { Event } from "../types.js";

export interface CompactionResult {
  events: Event[];
  summary: string;
  foldedCount: number;
  droppedRange?: { from: number; to: number };
}

export interface FoldOptions {
  keepRecentMessages?: number;
  minChars?: number;
 /** Rolling tool-output window. When set, fold old tool_results once the
 * still-unfolded count exceeds this — regardless of size or token budget
 * (an early, token-independent trigger). `minChars` is ignored for these
 * overflow results. */
  maxUnfoldedToolResults?: number;
 /** Tool names whose results are folded only after every other eligible result
 * (file reads are the model's working memory; bash/grep/glob outputs summarise
 * well). */
  deferTools?: ReadonlySet<string>;
  /** Freeze map: once folded, reuse the same stub text so the prefix does not
   * churn. */
  stubMemo?: Map<string, string>;
}

/** Default defer list: reads stay verbatim until nothing else is left. */
export const FOLD_DEFER_TOOLS: ReadonlySet<string> = new Set(["read_file", "read_artifact"]);

/** Suggested window when an operator opts into count-based fold via
 * `maxToolResultsInContext`. Not applied by default: a tight cap rewrites
 * mid-history every turn and pins cache hits near ~60%. */
export const DEFAULT_MAX_TOOL_RESULTS_IN_CONTEXT = 6;

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
  const stubMemo = options.stubMemo;
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
  const foldAt = (e: Event & { type: "tool_result" }) => {
    folded++;
    const frozen = stubMemo?.get(e.toolCallId);
    const content = frozen ?? summariseToolResult(e);
    if (stubMemo && !frozen) stubMemo.set(e.toolCallId, content);
    return { ...e, content, artifactRef: e.artifactRef ?? undefined };
  };
  let out = events.map((e, idx) => {
    if (idx >= cutoff || !eligible(e, false)) return e;
    return foldAt(e as Event & { type: "tool_result" });
  });
  if (folded === 0) {
    out = events.map((e, idx) => {
      if (idx >= cutoff || !eligible(e, true)) return e;
      return foldAt(e as Event & { type: "tool_result" });
    });
  }
  // Rolling tool-output window: once still-unfolded old results exceed
  // `maxUnfoldedToolResults`, fold the oldest down to that count — even if each
  // is under `minChars`. Deferred tools (read_file) folded last, preserving order.
  const cap = options.maxUnfoldedToolResults;
  if (cap !== undefined && cap >= 0) {
    out = foldRollingWindow(out, cutoff, cap, defer, foldAt);
  }
  return { events: out, foldedCount: folded };
}

/** Fold the oldest unfolded tool_results before `cutoff` until at most `cap`
 * remain, ignoring the per-result size floor. Oldest first; within the same
 * age, non-deferred (bash/grep) before deferred (read_file). */
function foldRollingWindow(
  events: Event[],
  cutoff: number,
  cap: number,
  defer: ReadonlySet<string>,
  foldAt: (e: Event & { type: "tool_result" }) => Event,
): Event[] {
  const isUnfolded = (e: Event): e is Event & { type: "tool_result" } =>
    e.type === "tool_result" && !e.content.startsWith("[folded tool_result");
  const oldIdx: number[] = [];
  for (let i = 0; i < cutoff; i++) if (isUnfolded(events[i]!)) oldIdx.push(i);
  const overflow = oldIdx.length - cap;
  if (overflow <= 0) return events;
  // Prefer folding non-deferred results first; take the oldest `overflow`.
  const ordered = [
    ...oldIdx.filter((i) => !defer.has((events[i] as Event & { type: "tool_result" }).name)),
    ...oldIdx.filter((i) => defer.has((events[i] as Event & { type: "tool_result" }).name)),
  ];
  const toFold = new Set(ordered.slice(0, overflow));
  return events.map((e, idx) =>
    toFold.has(idx) ? foldAt(e as Event & { type: "tool_result" }) : e,
  );
}

/** Build the short stub that replaces a full tool_result body in the model view. */
export function buildToolResultStub(e: Event & { type: "tool_result" }): string {
  return summariseToolResult(e);
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
 // Provenance tag so a later summary (or the model) can tell a tool-verified
 // fact from an unverified claim. Read/search tools yield ground truth about
 // files; mutating/exec tools are actions, not facts to cite.
  const tag = provenanceTag(e.name, e.isError === true);
  return `[folded tool_result of ${e.name} (${e.content.length} chars) ${tag} — this call already ran and you already saw its output.${refetch}${
    e.artifactRef ? ` artifactRef=${e.artifactRef}` : ""
  }]\n${head}${tail}`;
}

/** Classify a folded tool result's provenance for later citation/summary. */
function provenanceTag(toolName: string, isError: boolean): string {
  if (isError) return "[ERROR]";
  switch (toolName) {
    case "read_file":
    case "read_artifact":
    case "grep":
    case "glob":
    case "ls":
    case "diagnostics":
    case "lsp_navigate":
      return "[VERIFIED via tool output]";
    case "web_fetch":
    case "web_search":
      return "[EXTERNAL — verify before citing]";
    default:
      return "[ACTION]";
  }
}

export function findCutoff(events: Event[], keep: number): number {
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
