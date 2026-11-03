// Cache-waste attribution contracts.
//
// analyzeCacheWaste turns the per-turn usage stream the session already records
// into an attributed, dollar-quantified view: each re-billed (un-cached) turn
// is blamed on idle-TTL expiry, a model switch, or an expected re-bill at a
// compaction boundary. These pin the attribution rules.

import { describe, expect, it } from "vitest";
import {
  analyzeCacheWaste,
  DEFAULT_CACHE_TTL_MS,
  CACHE_MISS_NOISE_FLOOR,
  type CacheTurn,
} from "../src/cacheStats.js";

const MODEL = "claude-sonnet-4-5";

function turn(p: Partial<CacheTurn> & { at: number }): CacheTurn {
  return {
    model: MODEL,
    input: 10_000,
    cacheRead: 0,
    ...p,
  };
}

describe("analyzeCacheWaste", () => {
  it("counts the first turn as a non-waste cold start", () => {
    const r = analyzeCacheWaste([turn({ at: 0 })]);
    expect(r.wastedTokens).toBe(0);
    expect(r.misses).toHaveLength(1);
    expect(r.misses[0]!.cause).toBe("cold_start");
  });

  it("treats a warm turn (served from cache) as a hit, not waste", () => {
    const r = analyzeCacheWaste([
      turn({ at: 0 }),
      // Second turn mostly cached: input small, cacheRead large.
      turn({ at: 1000, input: 10_200, cacheRead: 10_000 }),
    ]);
    // Re-bill = 200 tokens < noise floor → a hit.
    expect(r.wastedTokens).toBe(0);
    expect(r.misses.filter((m) => m.cause !== "cold_start")).toHaveLength(0);
  });

  it("attributes an idle gap over the TTL to idle_expiry", () => {
    const r = analyzeCacheWaste([
      turn({ at: 0 }),
      turn({ at: DEFAULT_CACHE_TTL_MS + 1, input: 10_000, cacheRead: 0 }),
    ]);
    const miss = r.misses.find((m) => m.turnIndex === 1)!;
    expect(miss.cause).toBe("idle_expiry");
    expect(miss.missedTokens).toBe(10_000);
    expect(r.wastedTokens).toBe(10_000);
    expect(r.wastedCostUSD).toBeGreaterThan(0);
  });

  it("attributes a model switch within the TTL to model_switch", () => {
    const r = analyzeCacheWaste([
      turn({ at: 0 }),
      turn({ at: 1000, model: "claude-opus-4-1", input: 10_000, cacheRead: 0 }),
    ]);
    expect(r.misses.find((m) => m.turnIndex === 1)!.cause).toBe("model_switch");
  });

  it("does not count an expected re-bill at a compaction boundary as waste", () => {
    const r = analyzeCacheWaste([
      turn({ at: 0 }),
      turn({ at: 1000, input: 10_000, cacheRead: 0, contextChanged: true }),
    ]);
    expect(r.wastedTokens).toBe(0);
    expect(r.expectedRebills).toBe(1);
    expect(r.misses.find((m) => m.turnIndex === 1)).toBeUndefined();
  });

  it("falls back to 'unknown' for a miss with no idle/model explanation", () => {
    const r = analyzeCacheWaste([
      turn({ at: 0 }),
      turn({ at: 1000, input: 10_000, cacheRead: 0 }),
    ]);
    expect(r.misses.find((m) => m.turnIndex === 1)!.cause).toBe("unknown");
  });

  it("respects the noise floor for tiny re-bills", () => {
    const r = analyzeCacheWaste([
      turn({ at: 0 }),
      turn({ at: 1000, input: CACHE_MISS_NOISE_FLOOR, cacheRead: 0 }),
    ]);
    // Re-bill exactly at the floor is not a miss.
    expect(r.wastedTokens).toBe(0);
  });
});
