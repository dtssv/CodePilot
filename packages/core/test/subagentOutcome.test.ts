import { describe, expect, it } from "vitest";
import {
  assessSubagentOutcome,
  parseBudgetExtensionAnswer,
  detectDegenerateText,
  detectRunawayRepetition,
} from "../src/subagent.js";
import type { Event } from "../src/types.js";
import { taskTool } from "../src/tools/task.js";

describe("parseBudgetExtensionAnswer", () => {
  it("parses continue / unlimited / stop labels", () => {
    expect(parseBudgetExtensionAnswer(`Continue (+20 turns)`, 20)).toEqual({
      kind: "more",
      turns: 20,
    });
    expect(parseBudgetExtensionAnswer("Continue (no limit)", 20)).toEqual({ kind: "unlimited" });
    expect(parseBudgetExtensionAnswer("Stop", 20)).toEqual({ kind: "stop" });
    expect(parseBudgetExtensionAnswer(undefined, 20)).toEqual({ kind: "stop" });
  });
});

describe("assessSubagentOutcome", () => {
  it("marks provider errors with no text as failed and surfaces the message", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "OBJECTIVE" }],
      },
      {
        type: "error",
        message: 'OpenAI 404: {"error":{"message":"Model not exist."}}',
        recoverable: true,
      },
      { type: "status", status: "idle" },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(false);
    expect(r.steps).toBe(0);
    expect(r.conclusion).toMatch(/### Blocker/);
    expect(r.conclusion).toMatch(/Model not exist/);
  });

  it("marks empty assistant output as failed", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "   " }],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(false);
    expect(r.conclusion).toMatch(/no final text/);
  });

  // Regression: the real failure from session 655f96b5 — a sub-agent that
  // said "I'll read the files…" then collapsed into "}`}`}`…" × thousands,
  // yet was adopted as a successful conclusion (it had non-empty text).
  it("marks a degenerate decode-loop output as failed (incoherent garbage form)", () => {
    const garbage = "我将先阅读所有目标文件。让我并行加载它们。`。" + "}`".repeat(16000);
    const events: Event[] = [
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: garbage }],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(false);
    expect(r.conclusion).toMatch(/### Blocker/);
    expect(r.conclusion).toMatch(/degenerated into repeated noise/);
  });

  // Regression: sub-agents A/B from the same session — "I'll analyze… read all
  // files in parallel" with ZERO tool steps, previously adopted as ok. The hard
  // rule (borrowed from dsh): 0 tool steps = failure, regardless of text.
  it("marks any 0-step run as failed even with substantial text (premature-termination form)", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I'll analyze the tool system modules. Let me read all the files in parallel batches. First, let me verify file sizes and existence.",
          },
        ],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(false);
    expect(r.steps).toBe(0);
    expect(r.conclusion).toMatch(/### Blocker/);
    expect(r.conclusion).toMatch(/0 tool steps/);
  });

  it("marks a 0-step run as failed even when the text looks like a real conclusion", () => {
    // No tool calls at all — the model fabricated findings from nothing.
    const events: Event[] = [
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "### Findings\n- server.ts:120 mints the grant\n### Recommendation\n- filter cwds",
          },
        ],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(false);
    expect(r.steps).toBe(0);
    expect(r.conclusion).toMatch(/0 tool steps/);
  });

  it("accepts a conclusion once the run actually used a tool", () => {
    const events: Event[] = [
      { type: "tool_call", id: "t1", name: "read_file", input: { path: "a.ts" } },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I'll summarize: the module exports a parser and a formatter; both are covered by tests.",
          },
        ],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(true);
    expect(r.steps).toBe(1);
  });

  it("returns ok with the assistant text when the run succeeded", () => {
    const events: Event[] = [
      {
        type: "tool_call",
        id: "t1",
        name: "grep",
        input: { pattern: "x" },
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "### Findings\n- found it\n\n### Key references\n- `a.ts:1`\n\n### Recommendations\n- none",
          },
        ],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(true);
    expect(r.steps).toBe(1);
    expect(r.conclusion).toContain("### Findings");
  });
});

describe("detectDegenerateText", () => {
  it("flags a short-unit repetition collapse", () => {
    expect(detectDegenerateText("}`".repeat(5000))).not.toBeNull();
    expect(detectDegenerateText("a".repeat(1000))).not.toBeNull();
    expect(detectDegenerateText("ababab".repeat(500))).not.toBeNull();
  });

  it("does not flag normal prose or code", () => {
    const prose =
      "The parser reads tokens left to right, builds an AST, and the formatter " +
      "walks that tree to emit text. Edge cases: empty input, trailing commas, " +
      "and nested blocks are all covered by the test suite in edit_file.test.ts.";
    expect(detectDegenerateText(prose.repeat(3))).toBeNull();
  });

  it("ignores short strings entirely", () => {
    expect(detectDegenerateText("}`}`}`}`")).toBeNull();
  });
});

describe("detectRunawayRepetition", () => {
  it("flags a phrase-level repetition loop (I call X, I execute X …)", () => {
    const loop = "I call read_file. I execute read_file. ".repeat(200);
    const r = detectRunawayRepetition(loop);
    expect(r).not.toBeNull();
    expect(r!.repeats).toBeGreaterThanOrEqual(6);
  });

  it("flags a medium-length clause repeating", () => {
    const loop = "正在分析工具子系统，正在读取核心文件。".repeat(150);
    expect(detectRunawayRepetition(loop)).not.toBeNull();
  });

  it("does not flag normal long prose", () => {
    const prose =
      "The agent loop streams tokens, pairs tool calls with their results, and " +
      "folds old context to stay under the window. Compaction summarizes the " +
      "oldest turns while preserving the plan and the most recent exchanges. ";
    // ~1.8KB of varied prose — not periodic.
    const text = Array.from({ length: 8 }, (_, i) => prose + `Note ${i}: distinct sentence number ${i * 7 + 3}. `).join("");
    expect(detectRunawayRepetition(text)).toBeNull();
  });

  it("returns null for text below the window threshold", () => {
    expect(detectRunawayRepetition("short repeating ".repeat(3))).toBeNull();
  });

  it("does not flag repeated indentation / whitespace runs", () => {
    const code = `${" ".repeat(8)}return value;\n`.repeat(400);
    // The dominant period here is whitespace-heavy; the guard skips
    // whitespace-only units, and real code lines differ enough to not be
    // flagged as a single short period.
    const r = detectRunawayRepetition(code);
    if (r) expect(r.unit.trim().length).toBeGreaterThan(0);
  });
});

describe("task tool soft-failure reporting", () => {
  it("marks fan-out results as isError when runners return ok:false", async () => {
    const tool = taskTool;
    tool.runner = {
      async run() {
        return {
          ok: false,
          steps: 0,
          conclusion: "### Blocker\nOpenAI 404: Model not exist.",
        };
      },
    };
    tool._sem = undefined;
    const r = await tool.execute(
      {
        tasks: [
          { objective: "a", agent_type: "explore" },
          { objective: "b", agent_type: "explore" },
          { objective: "c", agent_type: "explore" },
        ],
      } as never,
      { cwd: "/tmp", subagentDepth: 0 } as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/0 ok/);
    expect(r.content).toMatch(/\(FAILED\)/);
    expect(r.content).toMatch(/Model not exist/);
  });
});

describe("task tool scale guards", () => {
  it("refuses to spawn once depth reaches the default max (3)", async () => {
    const tool = taskTool;
    tool.runner = { async run() { return { ok: true, steps: 1, conclusion: "done" }; } };
    tool._sem = undefined;
    tool._spawned = 0;
    tool.maxDepth = undefined; // use default
    const r = await tool.execute(
      { objective: "x", agent_type: "explore" } as never,
      { cwd: "/tmp", subagentDepth: 3 } as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/nesting depth 3 would exceed/);
  });

  it("trims a fan-out that would exceed the total-spawn cap", async () => {
    const tool = taskTool;
    let runs = 0;
    tool.runner = {
      async run() { runs++; return { ok: true, steps: 1, conclusion: "ok" }; },
    };
    tool._sem = undefined;
    tool._spawned = 0;
    tool.maxDepth = 3;
    tool.maxThreads = 4;
    tool.maxTotal = 2; // cap at 2 total
    const r = await tool.execute(
      {
        tasks: [
          { objective: "a", agent_type: "explore" },
          { objective: "b", agent_type: "explore" },
          { objective: "c", agent_type: "explore" },
        ],
      } as never,
      { cwd: "/tmp", subagentDepth: 0 } as never,
    );
    expect(runs).toBe(2); // third was trimmed
    expect(tool._spawned).toBe(2);
    expect(r.isError).toBeFalsy();
    // reset shared state for other tests
    tool.maxTotal = undefined;
    tool._spawned = 0;
  });

  it("refuses entirely once the total-spawn cap is already reached", async () => {
    const tool = taskTool;
    tool.runner = { async run() { return { ok: true, steps: 1, conclusion: "ok" }; } };
    tool._sem = undefined;
    tool.maxTotal = 5;
    tool._spawned = 5; // already at cap
    const r = await tool.execute(
      { objective: "x", agent_type: "explore" } as never,
      { cwd: "/tmp", subagentDepth: 0 } as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/already spawned 5 sub-agents/);
    tool.maxTotal = undefined;
    tool._spawned = 0;
  });

  it("counts a team roster against the total-spawn cap (refuses whole team when it would overflow)", async () => {
    const tool = taskTool;
    let runs = 0;
    tool.runner = {
      async run() { runs++; return { ok: true, steps: 1, conclusion: "ok" }; },
    };
    tool._sem = undefined;
    tool.maxDepth = 3;
    tool.maxTotal = 3;
    tool._spawned = 2; // only 1 slot left; a 2-member team must not partially run
    const r = await tool.execute(
      {
        objective: "reconcile",
        team: [
          { role: "worker", objective: "analyze" },
          { role: "specialist", objective: "critique" },
        ],
      } as never,
      { cwd: "/tmp", subagentDepth: 0 } as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exceed the cap of 3/);
    expect(runs).toBe(0); // no member ran — team is atomic
    expect(tool._spawned).toBe(2); // reservation rolled back, counter unchanged
    tool.maxTotal = undefined;
    tool._spawned = 0;
  });

  it("counts a team roster against the total-spawn cap (allows and increments when it fits)", async () => {
    const tool = taskTool;
    tool.runner = {
      async run() { return { ok: true, steps: 1, conclusion: "ok" }; },
    };
    tool._sem = undefined;
    tool.maxDepth = 3;
    tool.maxThreads = 4;
    tool.maxTotal = 10;
    tool._spawned = 0;
    const r = await tool.execute(
      {
        objective: "reconcile",
        team: [
          { role: "worker", objective: "analyze" },
          { role: "specialist", objective: "critique" },
        ],
      } as never,
      { cwd: "/tmp", subagentDepth: 0 } as never,
    );
    expect(r.isError).toBeFalsy();
    expect(tool._spawned).toBe(2); // the 2-member roster counted against the cap
    tool.maxTotal = undefined;
    tool._spawned = 0;
  });

  it("retries a transient sub-agent failure once", async () => {
    const tool = taskTool;
    let attempts = 0;
    tool.runner = {
      async run() {
        attempts++;
        if (attempts === 1) return { ok: false, steps: 0, conclusion: "OpenAI 429: rate limit" };
        return { ok: true, steps: 2, conclusion: "recovered" };
      },
    };
    tool._sem = undefined;
    tool._spawned = 0;
    tool.maxTotal = undefined;
    const r = await tool.execute(
      { objective: "x", agent_type: "explore" } as never,
      { cwd: "/tmp", subagentDepth: 0 } as never,
    );
    expect(attempts).toBe(2);
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/recovered/);
    tool._spawned = 0;
  });

  it("caches a successful sub-agent conclusion and reuses it on a repeat run", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "subagent-cache-"));
    try {
      const tool = taskTool;
      let runs = 0;
      tool.runner = {
        async run() {
          runs++;
          return { ok: true, steps: 3, conclusion: "the answer" };
        },
      };
      tool._sem = undefined;
      tool._spawned = 0;
      tool.maxTotal = undefined;
      const ctx = { cwd: "/tmp", subagentDepth: 0, projectStateDir: dir } as never;
      const input = { objective: "compute the answer", agent_type: "explore" } as never;

      const first = await tool.execute(input, ctx);
      expect(runs).toBe(1);
      expect(first.content).toMatch(/the answer/);

      // Second identical run: the conclusion is served from the durable cache,
      // the runner is NOT invoked again (resume after a crash would skip it).
      tool._sem = undefined;
      tool._spawned = 0;
      const second = await tool.execute(input, ctx);
      expect(runs).toBe(1); // unchanged — cache hit
      expect(second.content).toMatch(/the answer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
