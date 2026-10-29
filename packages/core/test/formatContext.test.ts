// formatContext: human-readable context report, incl. the semantic
// by-category breakdown with per-category proportions.

import { describe, expect, it } from "vitest";
import { formatContext, type ContextSummary } from "../src/management.js";

function base(): ContextSummary {
  return {
    totalTokens: 10_000,
    window: 200_000,
    usagePercent: 5,
    triggerThreshold: 184_000,
    triggerFraction: 0.92,
    autoCompactEnabled: true,
    byEventType: [],
    topFileReads: [],
    duplicateReads: [],
  };
}

describe("formatContext", () => {
  it("renders the header with usage percent and window", () => {
    const out = formatContext(base());
    expect(out).toMatch(/Context: 10,000 \/ 200,000 tokens \(5\.0%\)/);
    expect(out).toMatch(/auto-compact: on/);
  });

  it("renders a semantic by-category section with proportions summing to 100%", () => {
    const c = base();
    c.byCategory = [
      { category: "system", tokens: 4000 },
      { category: "tools", tokens: 3000 },
      { category: "conversation", tokens: 2000 },
      { category: "mcp", tokens: 1000 },
    ];
    const out = formatContext(c);
    expect(out).toMatch(/by category/);
    // Labels are humanized.
    expect(out).toMatch(/system prompt: 4,000 tok \(40\.0%\)/);
    expect(out).toMatch(/tool definitions: 3,000 tok \(30\.0%\)/);
    expect(out).toMatch(/conversation: 2,000 tok \(20\.0%\)/);
    expect(out).toMatch(/MCP tools: 1,000 tok \(10\.0%\)/);
  });

  it("omits the by-category section entirely when absent", () => {
    const out = formatContext(base());
    expect(out).not.toMatch(/by category/);
  });

  it("does not divide by zero when every category is empty", () => {
    const c = base();
    c.byCategory = [];
    const out = formatContext(c);
    // Empty array → section omitted, no NaN.
    expect(out).not.toMatch(/NaN/);
    expect(out).not.toMatch(/by category/);
  });
});
