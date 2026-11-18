// Context window estimation and compaction trigger geometry.

import type {
  Event,
  UsageInfo,
} from "../types.js";
import type { ChatProvider } from "../providers/types.js";
import { estimateTokens as defaultTokenEstimator, IMAGE_TOKEN_ESTIMATE } from "./tokens.js";

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
  /**
   * Skip the local-estimate gate and shrink toward ~50% of `contextWindow`.
   * Needed when the gateway already reported input over the configured
   * window but `estimateEventTokens` still under-counts (CJK/tools/images).
   */
  force?: boolean;
  /**
   * User-authored "compact instructions" — what the summary MUST preserve.
   * Merged from project memory, `/compact <focus…>`, and a PreCompact hook.
   * Appended to the summariser's system prompt; empty leaves it unchanged.
   */
  extraInstructions?: string;
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

// ---------------------------------------------------------------------------
// Compaction trigger geometry — ONE place for every coefficient. Feeds
// `compactionGeometry`, the single function turning a model window + config
// into the concrete trigger set every caller shares.
// ---------------------------------------------------------------------------

/** Default fraction of the context window at which we compact, unless the
 * config overrides it via `compactionThreshold`. */
export const DEFAULT_COMPACTION_FRACTION = 0.92;
/** Pre-compaction soft band: start compacting one turn early at this fraction
 * of the hard trigger (so the hot path reuses a ready summary). */
export const SOFT_COMPACTION_RATIO = 0.85;
/** Provider-reported-input safety net: force a compaction when the gateway
 * says the last request already used this fraction of the window, even if the
 * local estimate under-counted. */
export const PROVIDER_INPUT_COMPACTION_RATIO = 0.9;
/** Hard-trim the provider prompt to this fraction of the usable budget to
 * absorb estimator lag vs. the gateway's tokenizer. */
export const HARD_TRIM_RATIO = 0.8;
/** Task-boundary / forced-shrink target: collapse toward this fraction of the
 * window so a cleared context starts small. */
export const FORCED_SHRINK_RATIO = 0.5;
/** Floor for any derived trigger so a tiny/unknown window still leaves room. */
const MIN_TRIGGER_TOKENS = 4_000;

/** The concrete compaction trigger set derived from a model window + config.
 * Every auto-compaction caller shares this so their thresholds can't drift. */
export interface CompactionGeometry {
  /** The effective context window (config override or model lookup). */
  window: number;
  /** The fraction applied (config `compactionThreshold` or the default). */
  fraction: number;
  /** Output tokens reserved so we compact before the provider would reject. */
  outputReserve: number;
  /** Usable window after reserving output (never below the floor). */
  hardUsable: number;
  /** The hard trigger: compact synchronously at/above this token count. */
  hardTrigger: number;
  /** The soft trigger: pre-compact in the background at/above this count. */
  softTrigger: number;
}

/** Compute the shared compaction trigger geometry. Pure and side-effect free
 * so both the session and tests can call it. */
export function compactionGeometry(input: {
  window: number;
  /** `config.compactionThreshold` (fraction of the window). */
  thresholdFraction?: number;
  /** `config.maxTokens` — the caller's requested max output. */
  maxTokens?: number;
  /** Model's max output tokens, used when `maxTokens` is unset. */
  maxOutputTokens?: number;
}): CompactionGeometry {
  const window = input.window;
  const fraction = input.thresholdFraction ?? DEFAULT_COMPACTION_FRACTION;
  const outputReserve = Math.max(1_024, input.maxTokens ?? input.maxOutputTokens ?? 8_192);
  const hardUsable = Math.max(MIN_TRIGGER_TOKENS, window - outputReserve);
  const hardTrigger = Math.min(hardUsable, Math.floor(window * fraction));
  const softTrigger = Math.floor(hardTrigger * SOFT_COMPACTION_RATIO);
  return { window, fraction, outputReserve, hardUsable, hardTrigger, softTrigger };
}

/** Providers bill a downscaled image at roughly 1–1.6K tokens; base64 length
 * says nothing about it. */

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
        .map((b) =>
          b.type === "text" || b.type === "reasoning" ? b.text : JSON.stringify(b),
        )
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
    case "goal_request":
      return `goal_request:${e.objective}`;
    case "goal_progress":
      return `goal_progress:${e.round}:${e.status}`;
    case "edit_delta":
      return "";
    case "model":
      return `model:${e.model}${e.providerId ? `@${e.providerId}` : ""}`;
    case "retry":
    case "activity":
    case "stop_continue":
    case "interrupted_run":
    case "content_replacement":
    case "subagent":
    case "followup":
    case "pin":
    case "degeneration":
    case "undo_boundary":
    case "rewind":
    case "goal_status":
    case "tool_started":
    case "doom_loop":
    case "turn_budget":
    case "provider_failover":
      // Control events — not sent to the provider, so zero context cost.
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

/** Decide whether a usage update means compaction should run.
 * Trigger a bit before the hard window so the next request does not
 * overshoot (local char/4 estimates lag gateway tokenizers). */
export function usageSignalsCompact(usage: UsageInfo, window: number): boolean {
  const input = usage.input ?? 0;
  if (input <= 0 || window <= 0) return false;
  return input >= Math.floor(window * PROVIDER_INPUT_COMPACTION_RATIO);
}

