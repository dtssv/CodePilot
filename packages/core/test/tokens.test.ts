import { describe, expect, it, afterEach } from "vitest";
import {
  estimateTokens,
  heuristicTokens,
  setTokenizer,
  resetTokenizer,
  getActiveTokenizer,
  hasRealTokenizer,
  tryLoadRealTokenizer,
  estimateMessagesTokens,
  estimateObjectTokens,
  estimateEventsTokens,
  IMAGE_TOKEN_ESTIMATE,
  lookupContextWindow,
  resolveCompactionThreshold,
} from "../src/compaction/tokens.js";
import { estimateEventTokens } from "../src/compaction/compaction.js";
import type { Event } from "../src/types.js";

describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns at least 1 for any non-empty input", () => {
    expect(estimateTokens("a")).toBeGreaterThanOrEqual(1);
  });

  it("treats CJK characters as roughly one-per-token", () => {
    const t = estimateTokens("中文测试字符串");
 // 8 CJK chars → ~8 tokens.
    expect(t).toBeGreaterThanOrEqual(7);
    expect(t).toBeLessThanOrEqual(10);
  });

  it("treats English words as ~0.75 tokens per word", () => {
    const t = estimateTokens("the quick brown fox jumps over the lazy dog");
 // 9 words * 0.75 ≈ 6.75 → ceil 7
    expect(t).toBeGreaterThanOrEqual(6);
    expect(t).toBeLessThanOrEqual(9);
  });

  it("treats code-like punctuation as cheap", () => {
    const code = "const x = { a: 1, b: 2, c: 3 };";
    const t = estimateTokens(code);
 // 4 words + ~10 code chars / 3 ≈ 7.3 → ceil 8
    expect(t).toBeGreaterThanOrEqual(4);
    expect(t).toBeLessThanOrEqual(15);
  });

  it("is monotonic in input length", () => {
    let prev = 0;
    for (let i = 1; i < 200; i += 10) {
      const t = estimateTokens("a".repeat(i));
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("handles whitespace and newlines", () => {
    const t = estimateTokens("\n\n   \t\t\n");
    expect(t).toBe(0);
  });
});

describe("pluggable tokenizer", () => {
  afterEach(() => resetTokenizer());

  it("defaults to the heuristic", () => {
    expect(hasRealTokenizer()).toBe(false);
    expect(getActiveTokenizer()).toBe(heuristicTokens);
  });

  it("routes estimateTokens through an installed custom tokenizer", () => {
    // A tokenizer that counts whitespace-separated words exactly.
    setTokenizer((text) => (text.trim() ? text.trim().split(/\s+/).length : 0));
    expect(estimateTokens("one two three four")).toBe(4);
    expect(hasRealTokenizer()).toBe(true);
  });

  it("resetTokenizer restores the heuristic", () => {
    setTokenizer(() => 999);
    expect(estimateTokens("x")).toBe(999);
    resetTokenizer();
    expect(hasRealTokenizer()).toBe(false);
    expect(estimateTokens("x")).toBe(heuristicTokens("x"));
  });

  it("the custom tokenizer flows through the higher-level estimators", () => {
    setTokenizer((text) => (text ? text.length : 0)); // 1 token per char
    // estimateObjectTokens stringifies non-strings, so count === JSON length.
    expect(estimateObjectTokens("hello")).toBe(5);
    expect(estimateEventsTokens(["ab", "cde"], (s) => s)).toBe(5);
  });

  it("tryLoadRealTokenizer installs the BPE tokenizer", async () => {
    resetTokenizer();
    expect(await tryLoadRealTokenizer()).toBe(true);
    expect(hasRealTokenizer()).toBe(true);
    expect(estimateTokens("hello world")).toBe(2);
    // Code is where the heuristic undercounts most.
    const code = "export function f(a: number[]): Record<string, number> { return { n: a.length }; }\n".repeat(40);
    const bpe = estimateTokens(code);
    expect(bpe).toBeGreaterThan(heuristicTokens(code) * 1.3);
    // Long strings are memoised: a repeat lookup returns the same count.
    expect(estimateTokens(code)).toBe(bpe);
    resetTokenizer();
  });
});

describe("estimateMessagesTokens", () => {
  it("sums text content plus a per-message overhead", () => {
    const t = estimateMessagesTokens([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
 // 4 + hello(1) + 4 + world(1) = 10
    expect(t).toBeGreaterThanOrEqual(8);
    expect(t).toBeLessThanOrEqual(15);
  });

  it("handles array-of-blocks content", () => {
    const t = estimateMessagesTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", mediaType: "image/png", base64: "x" },
        ],
      },
    ]);
    expect(t).toBeGreaterThan(0);
  });

  it("prices an image through the single IMAGE_TOKEN_ESTIMATE source of truth", () => {
    const textOnly = estimateMessagesTokens([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    const withImage = estimateMessagesTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", mediaType: "image/png", base64: "x" },
        ],
      },
    ]);
    // The image adds exactly the shared constant, nothing more.
    expect(withImage - textOnly).toBe(IMAGE_TOKEN_ESTIMATE);
  });
});

describe("image token single source of truth", () => {
  it("prices an image identically on the message and event estimation paths", () => {
    // Both the provider-message estimator (estimateMessagesTokens) and the
    // event/compaction estimator (estimateEventTokens) must charge the SAME
    // per-image cost, or the self-calibration ratio would compare mismatched
    // numbers. This pins them to the one exported constant.
    const event: Event = {
      type: "message",
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      images: [{ mediaType: "image/png", base64: "x" }],
    };
    const base: Event = {
      type: "message",
      id: "m2",
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    const delta =
      estimateEventTokens([event], estimateTokens) -
      estimateEventTokens([base], estimateTokens);
    expect(delta).toBe(IMAGE_TOKEN_ESTIMATE);
  });
});

describe("estimateObjectTokens", () => {
  it("estimates a serialised object", () => {
    const t = estimateObjectTokens({ a: 1, b: "hello world" });
    expect(t).toBeGreaterThan(0);
  });
  it("handles null and undefined", () => {
    expect(estimateObjectTokens(null)).toBe(0);
    expect(estimateObjectTokens(undefined)).toBe(0);
  });
});

describe("estimateEventsTokens", () => {
  it("sums per-event serialised token costs", () => {
    const t = estimateEventsTokens(
      [{ a: 1 }, { b: 2 }, { c: 3 }],
      (e) => estimateTokens(JSON.stringify(e))
    );
 // Each event serialises to 7 chars → 3 tokens (1 each, ceil 3).
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(20);
  });
});

describe("lookupContextWindow", () => {
  it("ignores model id and returns the 200k default", () => {
    for (const id of [
      "claude-sonnet-4-5",
      "gpt-4o",
      "gpt-4.1",
      "deepseek-chat",
      "glm-4-plus",
      "kimi-k2",
      "totally-unknown-xyz",
    ]) {
      const w = lookupContextWindow(id);
      expect(w.contextWindow).toBe(200_000);
      expect(w.compactionThreshold).toBe(160_000);
    }
  });

  it("respects an explicit fallback", () => {
    const w = lookupContextWindow("totally-unknown-xyz", 32_000);
    expect(w.contextWindow).toBe(32_000);
    expect(w.compactionThreshold).toBe(25_600);
  });
});

describe("resolveCompactionThreshold", () => {
  it("uses 80% of the explicit configWindow when given", () => {
    expect(resolveCompactionThreshold("gpt-4o", 50_000)).toBe(40_000);
  });

  it("uses 80% of the default window when no configWindow", () => {
    expect(resolveCompactionThreshold("claude-sonnet-4-5", undefined)).toBe(160_000);
    expect(resolveCompactionThreshold("deepseek-v4.1-flash", undefined)).toBe(160_000);
  });
});
