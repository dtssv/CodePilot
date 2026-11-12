// Prompt-cache warming decision — a pure cost-gated function plus delay helper.
//
// Re-sending the last request with a 1-token cap before cache TTL expiry keeps
// the prefix warm; pays only when expected savings beat the warm cost. Default-
// safe (`warm: false` when TTL unknown); refuses warm if it'd change the budget.

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
 * enough to land before the entry lapses. */
export const CACHE_WARM_TTL_FRACTION = 0.9;

/**
 * The prompt-cache lifetime for a model, in ms, or undefined when the model has
 * no inline cache we warm (only Anthropic's `ephemeral` cache is refreshable;
 * OpenAI/Gemini are provider-managed). `promptCache.ttl` selects 5m/1h.
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
 * Decide whether to schedule a prompt-cache warm and when. Warm only when the
 * expected savings (P(continue)·missCost − warmCost) clear the threshold, the
 * model has a known TTL, and the replay is safe (identical request).
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
