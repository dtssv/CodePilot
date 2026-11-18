import { EventEmitter } from "node:events";

import type { Event, PlanStep } from "@codepilot/core";
import { render } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";

import { TranscriptItem } from "../src/ui/TranscriptView.js";
import { initialState, reducer, type TuiState } from "../src/ui/state.js";

const plan = (a: PlanStep["status"], b: PlanStep["status"]): PlanStep[] => [
  { id: "1", title: "Survey the project", status: a },
  { id: "2", title: "Write the report", status: b },
];

function run(events: Event[]): TuiState {
  let s = initialState({ sessionId: "s1", cwd: "/w", model: "m", permissionMode: "ask", agentMode: "agent" });
  s = reducer(s, { type: "set-busy", busy: true });
  for (const event of events) s = reducer(s, { type: "event", event });
  return s;
}

const SESSION: Event[] = [
  { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "Analyze this project" }] },
  { type: "plan", steps: plan("in_progress", "pending") },
  { type: "tool_call", id: "t1", name: "read_file", input: { path: "README.md" } },
  { type: "tool_result", toolCallId: "t1", name: "read_file", content: "# demo" },
  { type: "tool_call", id: "t2", name: "bash", input: { command: "npm test" } },
  { type: "tool_result", toolCallId: "t2", name: "bash", content: "line1\nline2\n3 passed" },
  { type: "usage", usage: { input: 10, output: 5 } },
  { type: "plan", steps: plan("completed", "in_progress") },
  { type: "tool_call", id: "t3", name: "write_file", input: { path: "REPORT.md", content: "a\nb\nc\n" } },
  { type: "tool_result", toolCallId: "t3", name: "write_file", content: "ok" },
  { type: "message", id: "a1", role: "assistant", content: [{ type: "text", text: "Done. I wrote **REPORT.md**." }] },
];

describe("retry", () => {
  it("drops the failed attempt's output and keeps one notice", () => {
    const retry = (attempt: number): Event => ({
      type: "retry",
      attempt,
      maxAttempts: 3,
      delayMs: 1000,
      reason: "stream reset",
      discardMessageId: "a2",
      discardToolCallIds: ["t9"],
    });
    const s = run([
      { type: "message_delta", messageId: "a2", delta: { type: "text", text: "I'll read" } },
      { type: "tool_call", id: "t9", name: "read_file", input: { path: "x" } },
      retry(1),
      retry(2),
    ]);
    expect(s.rows.map((r) => r.kind)).toEqual(["retry"]);
    expect(s.rows[0]).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });
});

/** Render rows to plain text through Ink. */
function renderText(state: TuiState): string {
  const out = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 60,
    isTTY: false,
    frames: [] as string[],
    write(chunk: string) {
      this.frames.push(chunk);
      return true;
    },
  });
  const el = React.createElement(
    React.Fragment,
    null,
    state.rows.map((row, i) => React.createElement(TranscriptItem, { key: i, row })),
  );
  const app = render(el, { stdout: out as never, debug: true, patchConsole: false });
  app.unmount();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
  return (out.frames.at(-1) ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("rendering", () => {
  // Ink's debug stdout capture is empty on some CI Linux runners (no TTY).
  it.skipIf(!!process.env.CI)("uses the shared step vocabulary", () => {
    const text = renderText(run(SESSION));
    expect(text).toContain("› Analyze this project");
    expect(text).toContain("Read");
    expect(text).toContain("README.md");
    expect(text).toContain("Bash");
    expect(text).toContain("npm test");
    expect(text).toContain("3 passed");
    expect(text).toContain("Write");
    expect(text).toContain("REPORT.md");
    expect(text).toContain("Plan");
    expect(text).toContain("◆");
    expect(text).toContain("Done. I wrote REPORT.md.");
    expect(text).not.toContain("usage");
  });
});

describe("markdown", () => {
  it.skipIf(!!process.env.CI)("renders lists and tables without hanging", () => {
    let s = initialState({ sessionId: "s1", cwd: "/w", model: "m", permissionMode: "ask", agentMode: "agent" });
    const md = "Steps:\n\n- one\n- two\n\n1. first\n2. second\n\n| File | Purpose |\n|---|---|\n| `a.ts` | Entry |\n| README.md | Intro |";
    s = reducer(s, { type: "event", event: { type: "message", id: "a", role: "assistant", content: [{ type: "text", text: md }] } });
    const text = renderText(s);
    expect(text).toContain("• two");
    expect(text).toContain("2. second");
    expect(text).toMatch(/File\s+Purpose/);
    expect(text).toMatch(/a\.ts\s+Entry/);
    expect(text).not.toContain("|---|");
  });
});
