// Prompt-cache warming decision.
//
// Why this exists
// ---------------
// A provider cache entry (Anthropic ephemeral, 5-minute default) lapses after
// an idle gap. If the user is likely to continue the session within that gap,
// re-sending the exact last request with a 1-token output cap just before the
// TTL expires keeps the cached prefix warm — the next real turn then hits the
// cache instead of re-billing the whole prefix at full input price.
//
// But warming is not free: each warm pays a cache-read (and sometimes a small
// cache-write) itself. It only pays off when the *expected* savings beat the
// warm's own cost. So this is a cost-gated decision, not an unconditional timer.
//
// Design stance (CodePilot): a PURE decision function plus a delay helper. It
// makes no provider calls and owns no timer — the session schedules the warm
// and performs the fail-soft replay. Default-safe: with no known model TTL it
// returns `{ warm: false }` (no warming) rather than guessing. A replay-safety
// guard refuses to warm when the 1-token replay would change the derived
// thinking budget and thus write a *different* cache entry (which would waste
// money and not keep the real prefix warm).

import { estimateCostUSD } from "./tokens.js";

export interface CacheWarmDecision {
  /** Whether a warm is worth scheduling. */
  warm: boolean;
  /** Delay from now until the warm should fire (ms). Only meaningful when `warm`. */
  delayMs: number;
  /** Expected net USD savings (positive) that justified the decision. */
  expectedSavingsUSD: number;
  /** Human-readable reason (telemetry / `/session`). */
  reason: string;
}

export interface CacheWarmInput {
  /** Model id (drives TTL + pricing). */
  model: string;
  /** Cache TTL for this model (ms). Undefined/0 ⇒ warming disabled. */
  ttlMs: number | undefined;
  /** Size of the cached prefix that would be re-billed on a miss (tokens). */
  prefixTokens: number;
  /**
   * Probability the user continues within the TTL (0..1). A measured idle
   * continuation rate; the caller may lower it when the session looks done.
   */
  continuationProbability: number;
  /**
   * Would a 1-token replay produce a DIFFERENT request than the live one —
   * e.g. a budget-derived thinking block that changes with max_tokens? When
   * true, warming would write a different cache entry and is refused.
   */
  replayWouldDiffer: boolean;
}

/** Fire the warm at 90% of the TTL — late enough to cover the idle gap, early
 * enough to land before the entry lapses. (Matches pi's 0.9·TTL.) */
export const CACHE_WARM_TTL_FRACTION = 0.9;

/**
 * The prompt-cache lifetime for a model, in ms, or undefined when the model has
 * no inline cache we warm. Only Anthropic exposes an explicit `ephemeral`
 * breakpoint cache that a replay can refresh; OpenAI/Gemini caches are implicit
 * and provider-managed, so warming them is not meaningful. The configured
 * breakpoint TTL (`promptCache.ttl`) selects the 5-minute default or the
 * extended one-hour lifetime; attribution and warm timing read the same value.
 */
export function cacheTtlMs(
  model: string | undefined,
  ttl?: "5m" | "1h",
): number | undefined {
  const id = (model ?? "").toLowerCase();
  if (id.includes("claude")) return ttl === "1h" ? 60 * 60_000 : 5 * 60_000;
  return undefined;
}

/** Minimum expected net savings to bother warming. Below this the warm's own
 * cost and request overhead aren't worth it. */
export const CACHE_WARM_MIN_SAVINGS_USD = 0.05;

/**
 * Decide whether to schedule a prompt-cache warm and when.
 *
 * expectedSavings = P(continue) · missCost − warmCost
 *   missCost = full input price of re-billing the prefix (what a miss costs).
 *   warmCost = cache-read price of the prefix (what the warm itself costs).
 * Warm only when expectedSavings ≥ the minimum threshold, the model has a known
 * TTL, and the replay is safe (identical request).
 */
export function decideCacheWarm(input: CacheWarmInput): CacheWarmDecision {
  const none = (reason: string): CacheWarmDecision => ({
    warm: false,
    delayMs: 0,
    expectedSavingsUSD: 0,
    reason,
  });

  if (!input.ttlMs || input.ttlMs <= 0) return none("no known cache TTL for model");
  if (input.prefixTokens <= 0) return none("no cached prefix to keep warm");
  if (input.replayWouldDiffer) return none("replay would write a different cache entry");
  const p = Math.max(0, Math.min(1, input.continuationProbability));
  if (p <= 0) return none("continuation unlikely");

  // Miss cost: re-billing the whole prefix at full input price.
  const missCost = estimateCostUSD(input.model, { input: input.prefixTokens });
  // Warm cost: the warm serves the prefix from cache, so it pays cache-read.
  const warmCost = estimateCostUSD(input.model, { cacheRead: input.prefixTokens });
  if (missCost === undefined || warmCost === undefined) {
    return none("model not priced");
  }

  const expectedSavingsUSD = p * missCost - warmCost;
  if (expectedSavingsUSD < CACHE_WARM_MIN_SAVINGS_USD) {
    return none(
      `expected savings $${expectedSavingsUSD.toFixed(4)} below $${CACHE_WARM_MIN_SAVINGS_USD} threshold`,
    );
  }

  return {
    warm: true,
    delayMs: Math.floor(input.ttlMs * CACHE_WARM_TTL_FRACTION),
    expectedSavingsUSD,
    reason: `expected savings $${expectedSavingsUSD.toFixed(4)} (p=${p}, prefix=${input.prefixTokens})`,
  };
}
