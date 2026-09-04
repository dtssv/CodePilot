import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  estimateMessagesTokens,
  estimateObjectTokens,
  estimateEventsTokens,
  lookupContextWindow,
  resolveCompactionThreshold,
} from "../src/tokens.js";

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
  it("returns the Claude Sonnet 4.5 window for the right id", () => {
    const w = lookupContextWindow("claude-sonnet-4-5");
    expect(w.contextWindow).toBe(200_000);
    expect(w.compactionThreshold).toBe(160_000);
  });

  it("returns the Claude 4-1 window", () => {
    expect(lookupContextWindow("claude-opus-4-1").contextWindow).toBe(200_000);
  });

  it("returns 128k for GPT-4o", () => {
    expect(lookupContextWindow("gpt-4o").contextWindow).toBe(128_000);
  });

  it("returns 1M for GPT-4.1", () => {
    expect(lookupContextWindow("gpt-4.1").contextWindow).toBe(1_000_000);
  });

  it("returns 64k for deepseek-chat", () => {
    expect(lookupContextWindow("deepseek-chat").contextWindow).toBe(64_000);
  });

  it("returns 128k for glm-4-plus", () => {
    expect(lookupContextWindow("glm-4-plus").contextWindow).toBe(128_000);
  });

  it("returns 128k for kimi-k2", () => {
    expect(lookupContextWindow("kimi-k2").contextWindow).toBe(128_000);
  });

  it("falls back to 128k default for unknown models", () => {
    const w = lookupContextWindow("totally-unknown-xyz");
    expect(w.contextWindow).toBe(128_000);
    expect(w.compactionThreshold).toBe(102_400);
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

  it("uses the model's table when no configWindow", () => {
    expect(resolveCompactionThreshold("claude-sonnet-4-5", undefined)).toBe(160_000);
  });
});
