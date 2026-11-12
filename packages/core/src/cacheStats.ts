// Cache-waste attribution.
//
// Why this exists
// ---------------
// Prompt caching is only cheap when the stable prefix keeps hitting. When a
// turn re-bills input tokens that *should* have been cached, something broke
// the hit: the cache TTL lapsed during an idle gap, the model switched (a
// different model has a different cache), or the context legitimately changed
// at a compaction / branch boundary (in which case the re-bill is expected, not
// waste). CodePilot already aggregates per-turn `cacheRead` / `cacheWrite` from
// provider usage; this module turns that raw stream into an attributed,
// dollar-quantified view so the cost is visible and explainable.
//
// Design stance (CodePilot): a pure function over the turn stream, like
// `compactionGeometry` / `filterToolsByMode`. No timers, no provider calls — it
// only interprets usage records the session already records. Fail-soft: unknown
// model price yields an undefined cost (never a fabricated zero), and the
// first turn is never counted as waste (there is nothing cached yet).

import { estimateCostUSD } from "./tokens.js";

/** A single turn's cache-relevant usage, in model-reported tokens. */
export interface CacheTurn {
  /** Wall-clock time the turn's request was sent (ms epoch). */
  at: number;
  /** Model id used for this turn. */
  model: string;
  /** Input tokens billed at full price this turn. */
  input: number;
  /** Tokens served from cache this turn (0 when nothing hit). */
  cacheRead: number;
  /** Tokens written to the cache this turn (cache-create), if reported. */
  cacheWrite?: number;
  /**
   * True when the context legitimately changed just before this turn
   * (compaction ran, or a branch/new-task boundary). A re-bill here is
   * expected — new prompt content, not a broken cache — so it is NOT waste.
   */
  contextChanged?: boolean;
}

export type CacheMissCause =
  | "idle_expiry" // the gap since the previous turn exceeded the cache TTL
  | "model_switch" // a different model than the previous turn → different cache
  | "cold_start" // first cacheable turn; nothing to reuse yet (not billed as waste)
  | "unknown"; // a miss we cannot attribute to idle/model (e.g. prefix drift)

export interface CacheMiss {
  turnIndex: number;
  cause: CacheMissCause;
  /** Input tokens re-billed that a hit would have served from cache. */
  missedTokens: number;
  /** USD cost of the re-bill (undefined when the model is not priced). */
  missedCostUSD?: number;
  /** Idle gap before this turn (ms). */
  idleMs: number;
}

export interface CacheWasteReport {
  misses: CacheMiss[];
  /** Total re-billed tokens attributed to a *fixable* miss (idle/model/unknown). */
  wastedTokens: number;
  /** Total USD of fixable waste (sum of priced misses). */
  wastedCostUSD: number;
  /** Count of turns whose re-bill was expected (context changed) — not waste. */
  expectedRebills: number;
}

/**
 * The standard `ephemeral` cache lifetime (Anthropic default). A gap longer
 * than the active TTL between turns means the previous turn's cached prefix has
 * expired, so the next turn pays full price again. `analyzeCacheWaste` takes the
 * configured TTL (5m default, or the extended 1h tier via `promptCache.ttl`);
 * this constant is the 5m fallback when no TTL is supplied.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Tokens below this are breakpoint-granularity noise, not a real miss: a cache
 * boundary never lands exactly on the token, so a hit still re-bills a small
 * remainder.
 */
export const CACHE_MISS_NOISE_FLOOR = 1024;

/**
 * Attribute each turn's re-billed input to a cause and quantify the waste.
 *
 * A turn "re-bills" when it has substantial `input` but little or no
 * `cacheRead` even though a previous turn established a cache. The cause is:
 *   - idle_expiry: the idle gap exceeded `ttlMs` → the entry lapsed.
 *   - model_switch: the model differs from the previous turn.
 *   - cold_start: the first cacheable turn (not waste — nothing to reuse).
 *   - unknown: a miss with no idle/model explanation (likely prefix drift).
 * A turn flagged `contextChanged` is an expected re-bill (new content), never
 * waste.
 */
export function analyzeCacheWaste(
  turns: readonly CacheTurn[],
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
): CacheWasteReport {
  const misses: CacheMiss[] = [];
  let wastedTokens = 0;
  let wastedCostUSD = 0;
  let expectedRebills = 0;
  let prev: CacheTurn | undefined;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const idleMs = prev ? Math.max(0, t.at - prev.at) : 0;
    // A turn "hit" when most of its input came from cache; a re-bill is a turn
    // that paid full input price for tokens a warm cache would have served.
    const rebilled = t.input - t.cacheRead;

    if (!prev) {
      // First turn: nothing cached yet. Record a non-waste cold_start marker.
      if (rebilled > CACHE_MISS_NOISE_FLOOR) {
        misses.push({ turnIndex: i, cause: "cold_start", missedTokens: 0, idleMs });
      }
      prev = t;
      continue;
    }

    if (rebilled <= CACHE_MISS_NOISE_FLOOR) {
      prev = t;
      continue; // a genuine hit (within noise) — no miss.
    }

    if (t.contextChanged) {
      // Compaction/branch boundary: the prompt legitimately changed, so the
      // re-bill is new content, not broken caching.
      expectedRebills++;
      prev = t;
      continue;
    }

    let cause: CacheMissCause;
    if (idleMs > ttlMs) cause = "idle_expiry";
    else if (t.model !== prev.model) cause = "model_switch";
    else cause = "unknown";

    const missedCostUSD = estimateCostUSD(t.model, { input: rebilled });
    misses.push({ turnIndex: i, cause, missedTokens: rebilled, missedCostUSD, idleMs });
    wastedTokens += rebilled;
    wastedCostUSD += missedCostUSD ?? 0;
    prev = t;
  }

  return { misses, wastedTokens, wastedCostUSD, expectedRebills };
}
