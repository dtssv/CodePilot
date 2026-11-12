// Compact Instructions: the user-controllable "what the summary MUST preserve"
// surface. Covers the pure helpers (compose / merge / section extraction), the
// PreCompact-hook additionalInstructions parse, and that the merged block
// actually reaches the summariser's system prompt during a real compact() run.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compact,
  composeSummaryPrompt,
  mergeCompactInstructions,
  SUMMARY_SYSTEM_PROMPT,
} from "../src/compaction.js";
import { extractCompactInstructions } from "../src/memory.js";
import { interpretDecision } from "../src/hooks-handlers.js";
import { HookEngine } from "../src/hooks.js";
import type { Event, ToolResultBlock } from "../src/types.js";
import type { ChatProvider } from "../src/providers/types.js";

function makeEvents(): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      type: "message",
      id: `m${i}`,
      role: "user",
      content: [{ type: "text", text: "user prompt " + i + " ".repeat(200) }],
    });
    events.push({
      type: "message",
      id: `a${i}`,
      role: "assistant",
      content: [
        { type: "text", text: "thinking " + "x".repeat(150) },
        { type: "tool_use", id: `tc${i}`, name: "bash", input: { command: "ls" } },
      ],
    });
    const big = "result line\n".repeat(800);
    const r: ToolResultBlock = { type: "tool_result", toolCallId: `tc${i}`, content: big };
    events.push({ type: "tool_result", toolCallId: `tc${i}`, name: "bash", content: big });
    void r;
  }
  return events;
}

describe("composeSummaryPrompt", () => {
  it("returns the base prompt unchanged when no instructions are given", () => {
    expect(composeSummaryPrompt()).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(composeSummaryPrompt("")).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(composeSummaryPrompt("   ")).toBe(SUMMARY_SYSTEM_PROMPT);
  });

  it("appends an Additional Instructions block with the given text", () => {
    const out = composeSummaryPrompt("Keep every file path verbatim.");
    expect(out.startsWith(SUMMARY_SYSTEM_PROMPT)).toBe(true);
    expect(out).toContain("## Additional Instructions");
    expect(out).toContain("Keep every file path verbatim.");
  });
});

describe("mergeCompactInstructions", () => {
  it("returns undefined with no sources", () => {
    expect(mergeCompactInstructions({})).toBeUndefined();
    expect(mergeCompactInstructions({ project: "  ", focus: "", hook: undefined })).toBeUndefined();
  });

  it("orders project → focus → hook", () => {
    const out = mergeCompactInstructions({ project: "P", focus: "F", hook: "H" });
    expect(out).toBe("P\n\nF\n\nH");
  });

  it("skips blank sources and collapses exact duplicates", () => {
    expect(mergeCompactInstructions({ project: "A", focus: "", hook: "B" })).toBe("A\n\nB");
    // Hook echoes the project block → deduped.
    expect(mergeCompactInstructions({ project: "same", hook: "same" })).toBe("same");
  });

  it("returns a single source verbatim", () => {
    expect(mergeCompactInstructions({ focus: "only focus" })).toBe("only focus");
  });
});

describe("extractCompactInstructions (project memory section)", () => {
  it("pulls a ## Compact Instructions section body", () => {
    const raw = [
      "# Project",
      "",
      "## Rules",
      "- be nice",
      "",
      "## Compact Instructions",
      "Always keep the failing test names and the repro steps.",
    ].join("\n");
    expect(extractCompactInstructions(raw)).toBe(
      "Always keep the failing test names and the repro steps.",
    );
  });

  it("matches case-insensitively and alternate titles", () => {
    expect(extractCompactInstructions("## COMPACTION INSTRUCTIONS\nkeep X")).toBe("keep X");
    expect(extractCompactInstructions("## Summary Instructions\nkeep Y")).toBe("keep Y");
  });

  it("returns undefined when absent", () => {
    expect(extractCompactInstructions("## Rules\n- x")).toBeUndefined();
    expect(extractCompactInstructions("")).toBeUndefined();
    expect(extractCompactInstructions(undefined)).toBeUndefined();
  });

  it("concatenates and dedups across layered documents", () => {
    const raw = [
      "<!-- from /a/CODEPILOT.md -->",
      "## Compact Instructions",
      "keep A",
      "",
      "---",
      "",
      "<!-- from /b/AGENTS.md -->",
      "## Compact Instructions",
      "keep B",
    ].join("\n");
    expect(extractCompactInstructions(raw)).toBe("keep A\n\nkeep B");
  });
});

describe("interpretDecision (PreCompact additionalInstructions)", () => {
  it("parses additionalInstructions from hook stdout JSON", () => {
    const d = interpretDecision({
      code: 0,
      stdout: JSON.stringify({ additionalInstructions: "preserve the deploy steps" }),
      stderr: "",
      timedOut: false,
    });
    expect(d.additionalInstructions).toBe("preserve the deploy steps");
  });

  it("accepts the snake_case spelling too", () => {
    const d = interpretDecision({
      code: 0,
      stdout: JSON.stringify({ additional_instructions: "snake case works" }),
      stderr: "",
      timedOut: false,
    });
    expect(d.additionalInstructions).toBe("snake case works");
  });

  it("is undefined when the hook returns none", () => {
    const d = interpretDecision({ code: 0, stdout: "{}", stderr: "", timedOut: false });
    expect(d.additionalInstructions).toBeUndefined();
  });
});

describe("runPreCompact collects a hook's additionalInstructions", () => {
  it("returns the hook's additionalInstructions and passes custom_instructions in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "precompact-"));
    try {
      const script = join(dir, "pre.sh");
      // Echo back the custom_instructions it received AND emit its own extra.
      writeFileSync(
        script,
        '#!/bin/sh\ncat >/dev/null\necho \'{"additionalInstructions":"keep the deploy runbook"}\'\n',
        "utf8",
      );
      chmodSync(script, 0o755);
      const h = new HookEngine({ PreCompact: [{ matcher: "*", command: script }] }, dir);
      h.setTrustFile(join(dir, "hook_trust.json"));
      await h.approveHook(script);
      await h.loadTrustedHashes();
      const r = await h.runPreCompact("manual", "from the file");
      expect(r.action).toBe("allow");
      expect(r.additionalInstructions).toBe("keep the deploy runbook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is undefined when no PreCompact hook emits additionalInstructions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "precompact-"));
    try {
      const h = new HookEngine({}, dir);
      const r = await h.runPreCompact("auto");
      expect(r.action).toBe("allow");
      expect(r.additionalInstructions).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compact() threads extraInstructions into the summariser prompt", () => {
  /** A fake summariser that records the system prompt it was called with. */
  function capturingSummariser(capture: { systemPrompt?: string }): ChatProvider {
    return {
      name: "fake",
      defaultModel: "m",
      smallModel: "s",
      async *stream(req: { systemPrompt?: string }) {
        capture.systemPrompt = req.systemPrompt;
        yield { kind: "text_delta", messageId: "m", text: "tiny handoff summary" };
        yield { kind: "done", finishReason: "stop" };
      },
    } as unknown as ChatProvider;
  }

  it("includes the Additional Instructions block when extraInstructions is set", async () => {
    const capture: { systemPrompt?: string } = {};
    const est = (s: string) => Math.ceil(s.length / 4);
    await compact(makeEvents(), {
      contextWindow: 2_000,
      keepRecentMessages: 2,
      estimateTokens: est,
      summariser: capturingSummariser(capture),
      summaryModel: "s",
      extraInstructions: "Preserve the exact error codes.",
    });
    expect(capture.systemPrompt).toBeDefined();
    expect(capture.systemPrompt!).toContain("## Additional Instructions");
    expect(capture.systemPrompt!).toContain("Preserve the exact error codes.");
  });

  it("uses the base prompt (no Additional Instructions) when none is set", async () => {
    const capture: { systemPrompt?: string } = {};
    const est = (s: string) => Math.ceil(s.length / 4);
    await compact(makeEvents(), {
      contextWindow: 2_000,
      keepRecentMessages: 2,
      estimateTokens: est,
      summariser: capturingSummariser(capture),
      summaryModel: "s",
    });
    expect(capture.systemPrompt).toBeDefined();
    expect(capture.systemPrompt!).not.toContain("## Additional Instructions");
  });
});
