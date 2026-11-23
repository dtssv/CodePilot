// Durable prune of old tool_result bodies in the model-facing transcript.
// Full text stays in the append-only JSONL; a `compaction`/`micro-fold` event
// records stubs that later rebuilds overlay onto matching toolCallIds.

import type { Event } from "../types.js";
import {
  FOLD_DEFER_TOOLS,
  buildToolResultStub,
  findCutoff,
} from "./fold.js";

/** Minimum inline length before a result is eligible to prune. */
export const DEFAULT_PRUNE_MIN_CHARS = 1_200;
/** Recent user/assistant messages whose tool bodies stay verbatim. */
export const DEFAULT_PRUNE_KEEP_MESSAGES = 8;
/**
 * Total chars of eligible (old, large, still-full) tool bodies that must
 * accumulate before a prune pass runs. Avoids rewriting the prefix for a
 * single modest result.
 */
export const DEFAULT_PRUNE_TRIGGER_CHARS = 12_000;

export interface ToolResultFold {
  toolCallId: string;
  name: string;
  content: string;
  originalChars: number;
}

export interface PrunePlan {
  folds: ToolResultFold[];
  charsSaved: number;
}

export interface PlanToolResultPruneOptions {
  keepRecentMessages?: number;
  minChars?: number;
  /** When set, only plan a prune if eligible chars ≥ this value. */
  triggerChars?: number;
  /**
   * Cap how far back pruning may reach (exclusive end index into `events`).
   * Used when a summary compaction is about to drop everything before a
   * retained tail — only the retained region is worth rewriting.
   */
  beforeIndex?: number;
  deferTools?: ReadonlySet<string>;
  /** Already-frozen stubs; reuse wording when a toolCallId was pruned before. */
  stubMemo?: Map<string, string>;
}

function isAlreadyPruned(content: string): boolean {
  return (
    content.startsWith("[folded tool_result") ||
    content.startsWith("[Old tool result content cleared]")
  );
}

/**
 * Decide which already-seen tool_results should become stubs. Returns null
 * when nothing qualifies or the trigger threshold is not met.
 */
export function planToolResultPrune(
  events: Event[],
  options: PlanToolResultPruneOptions = {},
): PrunePlan | null {
  const keep = options.keepRecentMessages ?? DEFAULT_PRUNE_KEEP_MESSAGES;
  const minChars = options.minChars ?? DEFAULT_PRUNE_MIN_CHARS;
  const triggerChars = options.triggerChars ?? DEFAULT_PRUNE_TRIGGER_CHARS;
  const defer = options.deferTools ?? FOLD_DEFER_TOOLS;
  const stubMemo = options.stubMemo;
  const end =
    options.beforeIndex !== undefined
      ? Math.max(0, Math.min(options.beforeIndex, events.length))
      : events.length;
  const slice = end < events.length ? events.slice(0, end) : events;
  const cutoff = findCutoff(slice, keep);
  if (cutoff <= 0) return null;

  type Cand = { idx: number; e: Event & { type: "tool_result" } };
  const candidates: Cand[] = [];
  for (let i = 0; i < cutoff; i++) {
    const e = slice[i]!;
    if (e.type !== "tool_result") continue;
    if (isAlreadyPruned(e.content)) continue;
    if (e.content.length <= minChars) continue;
    candidates.push({ idx: i, e });
  }
  if (candidates.length === 0) return null;

  const eligibleChars = candidates.reduce((n, c) => n + c.e.content.length, 0);
  if (eligibleChars < triggerChars) return null;

  // Prefer non-deferred tools first so read_file bodies survive longer.
  const ordered = [
    ...candidates.filter((c) => !defer.has(c.e.name)),
    ...candidates.filter((c) => defer.has(c.e.name)),
  ];

  const folds: ToolResultFold[] = [];
  let charsSaved = 0;
  for (const { e } of ordered) {
    const frozen = stubMemo?.get(e.toolCallId);
    const content = frozen ?? buildToolResultStub(e);
    if (stubMemo && !frozen) stubMemo.set(e.toolCallId, content);
    folds.push({
      toolCallId: e.toolCallId,
      name: e.name,
      content,
      originalChars: e.content.length,
    });
    charsSaved += Math.max(0, e.content.length - content.length);
  }
  if (folds.length === 0 || charsSaved <= 0) return null;
  return { folds, charsSaved };
}

/** Latest stub per toolCallId from durable micro-fold events in `events`. */
export function collectPruneOverlays(events: readonly Event[]): Map<string, string> {
  const stubs = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "compaction" || e.kind !== "micro-fold") continue;
    const folds = e.folds;
    if (!folds || folds.length === 0) continue;
    for (const f of folds) {
      if (f.toolCallId && f.content) stubs.set(f.toolCallId, f.content);
    }
  }
  return stubs;
}

/**
 * Overlay durable prune stubs onto tool_result bodies. Original events in the
 * JSONL are unchanged; this only shapes the model-facing copy.
 */
export function applyToolResultPruneOverlays(events: Event[]): Event[] {
  const stubs = collectPruneOverlays(events);
  if (stubs.size === 0) return events;
  let changed = false;
  const out = events.map((e) => {
    if (e.type !== "tool_result") return e;
    const stub = stubs.get(e.toolCallId);
    if (!stub || e.content === stub) return e;
    changed = true;
    return { ...e, content: stub };
  });
  return changed ? out : events;
}

/** Build the persisted micro-fold event for a prune plan. */
export function microFoldEventFromPlan(plan: PrunePlan): Extract<Event, { type: "compaction" }> {
  const names = [...new Set(plan.folds.map((f) => f.name))];
  const label = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")}…`;
  return {
    type: "compaction",
    kind: "micro-fold",
    summary:
      `Pruned ${plan.folds.length} tool result${plan.folds.length === 1 ? "" : "s"} ` +
      `(−${plan.charsSaved.toLocaleString()} chars): ${label}.`,
    folds: plan.folds.map((f) => ({
      toolCallId: f.toolCallId,
      name: f.name,
      content: f.content,
      originalChars: f.originalChars,
    })),
  };
}
