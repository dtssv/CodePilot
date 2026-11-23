import { describe, expect, it } from "vitest";

import type { Event } from "@codepilot/core";
import { initialState, reducer, type AppState } from "../src/state/reducer.js";
import {
  currentActivity,
  dateBucket,
  deriveUsageMetrics,
  endsInError,
  formatCacheRatio,
  formatDuration,
  groupRows,
  lastUserPrompt,
  planProgress,
  toolCategory,
  toolFilePaths,
  toolTarget,
  toolVerb,
  touchedFiles,
} from "../src/state/selectors.js";

function play(events: Event[], from: AppState = initialState()): AppState {
  return events.reduce((s, event) => reducer(s, { type: "event", event }), from);
}

const user = (id: string, text: string): Event => ({
  type: "message",
  id,
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (id: string, text: string): Event => ({
  type: "message",
  id,
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
});
const call = (id: string, name: string, input: unknown): Event => ({ type: "tool_call", id, name, input });
const result = (id: string, name: string, content: string, isError = false): Event => ({
  type: "tool_result",
  toolCallId: id,
  name,
  content,
  isError,
});

describe("groupRows", () => {
  it("collapses consecutive tool calls into one step group and drops usage rows", () => {
    const s = play([
      user("u1", "hi"),
      call("t1", "read_file", { path: "a.ts" }),
      result("t1", "read_file", "x"),
      call("t2", "grep", { pattern: "foo" }),
      result("t2", "grep", "y"),
      { type: "usage", usage: { input: 10, output: 2 } },
      assistant("a1", "done"),
    ]);
    const blocks = groupRows(s.rows);
    expect(blocks.map((b) => b.kind)).toEqual(["message", "assistant_turn"]);
    const turn = blocks[1];
    expect(turn?.kind).toBe("assistant_turn");
    if (turn?.kind !== "assistant_turn") return;
    expect(turn.parts.map((p) => p.kind)).toEqual(["steps", "message"]);
    const steps = turn.parts[0];
    expect(steps?.kind === "steps" && steps.tools.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("renders only the latest plan in full and hides plan tool steps", () => {
    const plan = (status: "pending" | "completed"): Event => ({
      type: "plan",
      steps: [{ id: "1", title: "Do it", status }],
    });
    const s = play([
      call("p1", "plan", { action: "update", steps: [] }),
      result("p1", "plan", "ok"),
      plan("pending"),
      assistant("a1", "working"),
      plan("completed"),
    ]);
    const blocks = groupRows(s.rows);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("assistant_turn");
    const turn = blocks[0];
    if (turn?.kind !== "assistant_turn") return;
    expect(turn.parts.filter((p) => p.kind === "steps")).toHaveLength(0);
    const plans = turn.parts.filter((p) => p.kind === "plan");
    expect(plans.map((p) => p.kind === "plan" && p.latest)).toEqual([false, true]);
  });

  it("skips tool-only assistant messages with no text", () => {
    const s = play([user("u1", "go"), assistant("a1", ""), call("t1", "ls", { path: "." })]);
    expect(groupRows(s.rows).map((b) => b.kind)).toEqual(["message", "assistant_turn"]);
    const turn = groupRows(s.rows)[1];
    expect(turn?.kind === "assistant_turn" && turn.parts.map((p) => p.kind)).toEqual(["steps"]);
  });

  it("folds multi-step tool loops into one assistant turn (一问一答)", () => {
    const s = play([
      user("u1", "go"),
      assistant("a0", "</think>"),
      call("t1", "bash", { command: "echo" }),
      result("t1", "bash", "ok"),
      assistant("a1", "平均薪资是 14000。"),
    ]);
    const blocks = groupRows(s.rows);
    expect(blocks.map((b) => b.kind)).toEqual(["message", "assistant_turn"]);
    const turn = blocks[1];
    expect(turn?.kind).toBe("assistant_turn");
    if (turn?.kind !== "assistant_turn") return;
    expect(turn.parts.map((p) => p.kind)).toEqual(["steps", "message"]);
    const answer = turn.parts[1];
    expect(answer?.kind === "message" && answer.msg.text).toContain("14000");
  });
});


describe("retry events", () => {
  it("drop the discarded partial message and tool calls, keeping one notice", () => {
    let s = play([
      user("u1", "go"),
      { type: "message_delta", messageId: "m1", delta: { type: "text", text: "partial" } },
      call("t1", "ls", { path: "." }),
    ]);
    s = play(
      [
        { type: "retry", attempt: 1, maxAttempts: 2, delayMs: 1500, reason: "ECONNRESET", discardMessageId: "m1", discardToolCallIds: ["t1"] },
        { type: "retry", attempt: 2, maxAttempts: 2, delayMs: 3000, reason: "ECONNRESET" },
      ],
      s,
    );
    expect(s.rows.map((r) => r.kind)).toEqual(["message", "retry"]);
    const retry = s.rows[1];
    expect(retry?.kind === "retry" && retry.retry.attempt).toBe(2);
    expect(s.status).toBe("thinking");
  });

  it("clears 429 retry banners once the stream resumes", () => {
    let s = play([
      user("u1", "go"),
      { type: "retry", attempt: 1, maxAttempts: 8, delayMs: 2000, reason: "HTTP 429" },
    ]);
    expect(s.rows.some((r) => r.kind === "retry")).toBe(true);
    s = play(
      [{ type: "message_delta", messageId: "m2", delta: { type: "text", text: "ok" } }],
      s,
    );
    expect(s.rows.some((r) => r.kind === "retry")).toBe(false);
    expect(s.rows.some((r) => r.kind === "message" && r.msg.text === "ok")).toBe(true);
  });

  it("clears 429 banners even when a usage row sits after the retry", () => {
    let s = play([
      user("u1", "go"),
      { type: "retry", attempt: 1, maxAttempts: 8, delayMs: 2000, reason: "HTTP 429: 访问限制" },
      { type: "usage", usage: { input: 100, output: 1 } },
    ]);
    expect(s.rows.some((r) => r.kind === "retry")).toBe(true);
    s = play(
      [{ type: "message_delta", messageId: "m2", delta: { type: "text", text: "done" } }],
      s,
    );
    expect(s.rows.some((r) => r.kind === "retry")).toBe(false);
  });
});

describe("derived views", () => {
  it("planProgress counts completed steps and finds the current one", () => {
    const p = planProgress([
      { id: "1", title: "a", status: "completed" },
      { id: "2", title: "b", status: "in_progress" },
      { id: "3", title: "c", status: "pending" },
    ]);
    expect(p).toMatchObject({ done: 1, total: 3, current: { id: "2" } });
  });

  it("touchedFiles merges edits per path and ignores failed writes", () => {
    const s = play([
      call("w1", "write_file", { path: "out.md", content: "a\nb\n" }),
      result("w1", "write_file", "ok"),
      call("e1", "edit_file", { path: "out.md", search: "a", replace: "A" }),
      result("e1", "edit_file", "ok"),
      call("w2", "write_file", { path: "denied.md", content: "x" }),
      result("w2", "write_file", "sandbox: refused", true),
    ]);
    const files = touchedFiles(s.rows);
    expect(files.map((f) => f.path)).toEqual(["out.md"]);
    expect(files[0]).toMatchObject({ kind: "written", edits: 2 });
  });

  it("lastUserPrompt, currentActivity and endsInError read the tail", () => {
    const s = play([
      user("u1", "first"),
      user("u2", "second"),
      call("t1", "bash", { command: "npm test" }),
    ]);
    expect(lastUserPrompt(s.rows)).toBe("second");
    expect(currentActivity(s.rows)?.id).toBe("t1");
    const failed = play([{ type: "error", message: "boom", recoverable: false }], s);
    expect(endsInError(failed.rows)).toBe(true);
    expect(endsInError(s.rows)).toBe(false);
  });

  it("classifies tools and extracts their target", () => {
    expect(toolCategory("read_file")).toBe("read");
    expect(toolCategory("bash_output")).toBe("bash");
    expect(toolCategory("mcp__github__search_issues")).toBe("search");
    expect(toolCategory("something_else")).toBe("other");
    expect(toolTarget({ command: "ls   -la\n" })).toBe("ls -la");
    expect(toolTarget({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTarget({ x: 1 })).toBe("");
    // grep: prefer the pattern over a search-root path so failures are readable.
    expect(
      toolTarget(
        { pattern: "(?i)needle", path: "/Users/me/CodePilot" },
        "grep",
      ),
    ).toBe("(?i)needle");
    expect(toolTarget({ pattern: "(?i)needle", path: "/Users/me/CodePilot" })).toBe(
      "/Users/me/CodePilot",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Add File: src/b.ts",
      "*** End Patch",
    ].join("\n");
    expect(toolTarget({ patch })).toBe("src/a.ts · + src/b.ts");
    expect(toolFilePaths({ patch })).toEqual(["src/a.ts", "src/b.ts"]);
    expect(toolVerb("apply_patch", { patch })).toBe("Edited");
    expect(
      toolVerb("apply_patch", {
        patch: "*** Begin Patch\n*** Add File: n.ts\n*** End Patch",
      }),
    ).toBe("Wrote");
    // task control actions are not "Delegated".
    expect(toolVerb("task", { action: "wait", session_id: "sub_abc" })).toBe(
      "Waited for subtask",
    );
    expect(toolVerb("task", { action: "interrupt", session_id: "sub_abc" })).toBe(
      "Interrupted subtask",
    );
    expect(toolVerb("task", { action: "list" })).toBe("Listed subtasks");
    expect(toolVerb("task", { objective: "do stuff" })).toBe("Delegated");
    expect(toolTarget({ action: "wait", session_id: "sub_abc" }, "task")).toBe("sub_abc");
  });

  it("formats durations and date buckets", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(2300)).toBe("2.3s");
    expect(formatDuration(75_000)).toBe("1m15s");
    const now = new Date(2026, 9, 10, 15, 0).getTime();
    expect(dateBucket(now - 60_000, now)).toBe("Today");
    expect(dateBucket(now - 20 * 3_600_000, now)).toBe("Yesterday");
    expect(dateBucket(now - 3 * 86_400_000, now)).toBe("Earlier");
  });

  it("derives total / cache / ratio (OpenAI inclusive vs Anthropic additive)", () => {
    // OpenAI: cached ⊆ prompt_tokens.
    const openai = deriveUsageMetrics({ input: 1000, output: 50, cacheRead: 800 });
    expect(openai.total).toBe(1050);
    expect(openai.cache).toBe(800);
    expect(openai.cacheRatio).toBeCloseTo(0.8);
    expect(formatCacheRatio(openai.cacheRatio)).toBe("80%");

    // Anthropic: cache fields are additive; cacheRead can exceed input.
    const anthropic = deriveUsageMetrics({
      input: 200,
      output: 40,
      cacheRead: 5000,
      cacheWrite: 100,
    });
    expect(anthropic.total).toBe(200 + 40 + 5000 + 100);
    expect(anthropic.cache).toBe(5100);
    expect(anthropic.cacheRatio).toBeCloseTo(5000 / (200 + 5000 + 100));
  });
});
