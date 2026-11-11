// Prompt-cache warm decision contracts.
//
// decideCacheWarm is a cost-gated, default-safe decision: warm only when the
// model has a known TTL, the replay is faithful, and the expected net savings
// (P(continue)·missCost − warmCost) clear the threshold. These pin the gates.

import { describe, expect, it } from "vitest";
import {
  decideCacheWarm,
  cacheTtlMs,
  CACHE_WARM_TTL_FRACTION,
  CACHE_WARM_MIN_SAVINGS_USD,
  type CacheWarmInput,
} from "../src/cacheWarmer.js";

function base(p: Partial<CacheWarmInput> = {}): CacheWarmInput {
  return {
    model: "claude-sonnet-4-5",
    ttlMs: 5 * 60_000,
    prefixTokens: 200_000,
    continuationProbability: 0.3,
    replayWouldDiffer: false,
    ...p,
  };
}

describe("cacheTtlMs", () => {
  it("returns a TTL for Anthropic models", () => {
    expect(cacheTtlMs("claude-sonnet-4-5")).toBe(5 * 60_000);
  });
  it("returns undefined for implicit-cache providers (OpenAI/Gemini)", () => {
    expect(cacheTtlMs("gpt-5")).toBeUndefined();
    expect(cacheTtlMs("gemini-2.5-pro")).toBeUndefined();
    expect(cacheTtlMs(undefined)).toBeUndefined();
  });
  it("returns the extended one-hour TTL for Anthropic when configured", () => {
    expect(cacheTtlMs("claude-sonnet-4-5", "1h")).toBe(60 * 60_000);
    expect(cacheTtlMs("claude-sonnet-4-5", "5m")).toBe(5 * 60_000);
    // Non-Anthropic stays undefined regardless of ttl.
    expect(cacheTtlMs("gpt-5", "1h")).toBeUndefined();
  });
});

describe("decideCacheWarm", () => {
  it("warms a large Anthropic prefix with decent continuation odds", () => {
    const d = decideCacheWarm(base());
    expect(d.warm).toBe(true);
    // Fires at 90% of the TTL.
    expect(d.delayMs).toBe(Math.floor(5 * 60_000 * CACHE_WARM_TTL_FRACTION));
    expect(d.expectedSavingsUSD).toBeGreaterThanOrEqual(CACHE_WARM_MIN_SAVINGS_USD);
  });

  it("does not warm when the model has no known cache TTL", () => {
    expect(decideCacheWarm(base({ ttlMs: undefined })).warm).toBe(false);
    expect(decideCacheWarm(base({ ttlMs: 0 })).warm).toBe(false);
  });

  it("does not warm when the replay would write a different cache entry", () => {
    expect(decideCacheWarm(base({ replayWouldDiffer: true })).warm).toBe(false);
  });

  it("does not warm when continuation is unlikely", () => {
    expect(decideCacheWarm(base({ continuationProbability: 0 })).warm).toBe(false);
  });

  it("does not warm a tiny prefix whose savings fall below the threshold", () => {
    // A 1k-token prefix on sonnet: missCost ≈ $0.003, nowhere near $0.05.
    expect(decideCacheWarm(base({ prefixTokens: 1_000 })).warm).toBe(false);
  });

  it("does not warm when the model is not priced", () => {
    expect(decideCacheWarm(base({ model: "some-unknown-model", ttlMs: 60_000 })).warm).toBe(
      false,
    );
  });
});
