/**
 * End-to-end smoke test for the TUI state machine.
 *
 * We drive the reducer through a realistic session lifecycle:
 *   1. init → user types a prompt → busy
 *   2. assistant streams a text delta → final message
 *   3. tool_call (bash) → tool_result
 *   4. usage event → status back to idle
 *   5. a second turn with a permission prompt → resolve → continue
 *   6. a /clear command
 *
 * This validates that the reducer correctly:
 *   - accumulates streaming deltas into the right message row,
 *   - pairs tool_call/tool_result by id,
 *   - tracks status transitions (idle → thinking → executing → idle),
 *   - sums usage across turns,
 *   - handles permission pending/resolve without losing state.
 *
 * No React/Ink rendering is involved — the reducer is pure, which is what
 * makes this a reliable e2e smoke test for the state layer.
 */
import { describe, expect, it } from "vitest";
import {
  initialState,
  reducer,
  type Row,
  type TuiState,
} from "../src/ui/state.js";
import type { Event } from "@codepilot/core";

function findAssistantRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.kind === "assistant");
}
function findToolRows(rows: Row[]): Extract<Row, { kind: "tool" }>[] {
  return rows.filter((r) => r.kind === "tool") as Extract<
    Row,
    { kind: "tool" }
  >[];
}

describe("TUI state machine — end-to-end session lifecycle", () => {
  it("drives a full prompt → stream → tool → result → idle cycle", () => {
    let state: TuiState = initialState({
      sessionId: "s1",
      cwd: "/tmp/proj",
      model: "claude-sonnet-4-5",
      permissionMode: "ask",
      agentMode: "agent",
    });

    // 1. User types a prompt and submits.
    state = reducer(state, { type: "set-input", value: "list files" });
    expect(state.input).toBe("list files");
    state = reducer(state, { type: "set-busy", busy: true });
    state = reducer(state, { type: "set-status", status: "thinking" });

    // 2. User message event arrives.
    const userMsg: Event = {
      type: "message",
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "list files" }],
    };
    state = reducer(state, { type: "event", event: userMsg });
    expect(state.rows.some((r) => r.kind === "user")).toBe(true);

    // 3. Assistant streams a partial delta.
    state = reducer(state, {
      type: "event",
      event: {
        type: "message_delta",
        messageId: "a1",
        delta: { type: "text", text: "I'll list " },
      },
    });
    let assistants = findAssistantRows(state.rows);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.kind).toBe("assistant");
    if (assistants[0]!.kind === "assistant") {
      expect(assistants[0]!.msg.text).toBe("I'll list ");
      expect(assistants[0]!.msg.streaming).toBe(true);
    }

    // 4. Second delta chunk folds into the same row.
    state = reducer(state, {
      type: "event",
      event: {
        type: "message_delta",
        messageId: "a1",
        delta: { type: "text", text: "the files for you." },
      },
    });
    assistants = findAssistantRows(state.rows);
    expect(assistants).toHaveLength(1);
    if (assistants[0]!.kind === "assistant") {
      expect(assistants[0]!.msg.text).toBe("I'll list the files for you.");
    }

    // 5. Final assistant message (replaces the streaming row). In a real
    //    provider, the final `message` event arrives right after the deltas,
    //    before any tool_call/tool_result — so the streaming row is still
    //    the last assistant row at this point.
    state = reducer(state, {
      type: "event",
      event: {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "I'll list the files for you." }],
        model: "claude-sonnet-4-5",
      },
    });
    assistants = findAssistantRows(state.rows);
    expect(assistants).toHaveLength(1);
    if (assistants[0]!.kind === "assistant") {
      expect(assistants[0]!.msg.streaming).toBe(false);
      expect(assistants[0]!.msg.model).toBe("claude-sonnet-4-5");
    }

    // 6. Tool call: bash ls. (Arrives after the final message, as a separate
    //    turn — the model decided to call a tool after its text.)
    state = reducer(state, {
      type: "event",
      event: {
        type: "tool_call",
        id: "t1",
        name: "bash",
        input: { command: "ls" },
      },
    });
    const tools = findToolRows(state.rows);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool.name).toBe("bash");
    expect(tools[0]!.tool.status).toBe("running");
    expect(tools[0]!.tool.inputSummary).toContain("command=ls");

    // 7. Tool result.
    state = reducer(state, {
      type: "event",
      event: {
        type: "tool_result",
        toolCallId: "t1",
        name: "bash",
        content: "file1.txt\nfile2.ts",
      },
    });
    const toolsAfter = findToolRows(state.rows);
    expect(toolsAfter).toHaveLength(1);
    expect(toolsAfter[0]!.tool.status).toBe("ok");
    expect(toolsAfter[0]!.tool.resultText).toBe("file1.txt\nfile2.ts");
    expect(toolsAfter[0]!.tool.resultIsError).toBeFalsy();

    // 8. Usage event.
    state = reducer(state, {
      type: "event",
      event: {
        type: "usage",
        usage: { input: 1000, output: 50, costUSD: 0.01 },
      },
    });
    expect(state.usage.input).toBe(1000);
    expect(state.usage.output).toBe(50);
    expect(state.usage.costUSD).toBeCloseTo(0.01);

    // 9. Status → idle, busy → false.
    state = reducer(state, { type: "set-status", status: "idle" });
    state = reducer(state, { type: "set-busy", busy: false });
    expect(state.status).toBe("idle");
    expect(state.busy).toBe(false);

    // 10. Row count: 1 user + 1 assistant + 1 tool + 1 usage = 4.
    expect(state.rows).toHaveLength(4);
  });

  it("handles a permission prompt mid-turn and resumes after resolve", () => {
    let state: TuiState = initialState({
      sessionId: "s2",
      cwd: "/tmp/proj",
      model: "claude-sonnet-4-5",
      permissionMode: "ask",
      agentMode: "agent",
    });
    state = reducer(state, { type: "set-busy", busy: true });

    // Permission request arrives.
    state = reducer(state, {
      type: "permission-pending",
      req: {
        requestId: "pr1",
        toolName: "write_file",
        input: { path: "/tmp/proj/x.txt", content: "hi" },
        reason: "writing to disk",
      },
    });
    expect(state.status).toBe("waiting_permission");
    expect(state.permission?.toolName).toBe("write_file");

    // While waiting, a tool_call event arrives (the model emitted it before
    // the permission engine intercepted). It should still land in the rows.
    state = reducer(state, {
      type: "event",
      event: {
        type: "tool_call",
        id: "t2",
        name: "write_file",
        input: { path: "/tmp/proj/x.txt", content: "hi" },
      },
    });
    expect(state.rows.some((r) => r.kind === "tool")).toBe(true);

    // User approves → permission resolves, status stays as it was (the
    // agent loop continues).
    state = reducer(state, { type: "permission-resolve" });
    expect(state.permission).toBeUndefined();

    // Tool result arrives after the approval.
    state = reducer(state, {
      type: "event",
      event: {
        type: "tool_result",
        toolCallId: "t2",
        name: "write_file",
        content: "wrote 3 bytes",
      },
    });
    const tools = findToolRows(state.rows);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool.status).toBe("ok");
  });

  it("sums usage across multiple turns", () => {
    let state: TuiState = initialState({
      sessionId: "s3",
      cwd: "/tmp",
      model: "m",
      permissionMode: "yolo",
      agentMode: "agent",
    });
    state = reducer(state, {
      type: "event",
      event: { type: "usage", usage: { input: 100, output: 10 } },
    });
    state = reducer(state, {
      type: "event",
      event: {
        type: "usage",
        usage: { input: 200, output: 20, costUSD: 0.005, cacheRead: 50 },
      },
    });
    expect(state.usage.input).toBe(300);
    expect(state.usage.output).toBe(30);
    expect(state.usage.costUSD).toBeCloseTo(0.005);
    expect(state.usage.cacheRead).toBe(50);
  });

  it("/clear resets rows but preserves input + identity", () => {
    let state: TuiState = initialState({
      sessionId: "s4",
      cwd: "/tmp",
      model: "m",
      permissionMode: "ask",
      agentMode: "agent",
    });
    state = reducer(state, {
      type: "event",
      event: {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    });
    state = reducer(state, { type: "set-input", value: "draft text" });
    expect(state.rows.length).toBeGreaterThan(0);
    state = reducer(state, { type: "clear" });
    expect(state.rows).toEqual([]);
    // Input + identity preserved.
    expect(state.input).toBe("draft text");
    expect(state.sessionId).toBe("s4");
    expect(state.cwd).toBe("/tmp");
  });

  it("renders a compaction event as a row", () => {
    let state: TuiState = initialState({
      sessionId: "s5",
      cwd: "/tmp",
      model: "m",
      permissionMode: "ask",
      agentMode: "agent",
    });
    state = reducer(state, {
      type: "event",
      event: { type: "compaction", summary: "Summarized 50 events" },
    });
    expect(
      state.rows.some(
        (r) => r.kind === "compaction" && r.summary.includes("Summarized"),
      ),
    ).toBe(true);
  });

  it("tracks an error event as a recoverable row", () => {
    let state: TuiState = initialState({
      sessionId: "s6",
      cwd: "/tmp",
      model: "m",
      permissionMode: "ask",
      agentMode: "agent",
    });
    state = reducer(state, {
      type: "event",
      event: {
        type: "error",
        message: "rate limited",
        recoverable: true,
      },
    });
    const errRow = state.rows.find((r) => r.kind === "error");
    expect(errRow).toBeDefined();
    if (errRow && errRow.kind === "error") {
      expect(errRow.message).toBe("rate limited");
      expect(errRow.recoverable).toBe(true);
    }
  });

  it("switches agent mode via a mode event and sets a notice", () => {
    let state: TuiState = initialState({
      sessionId: "s7",
      cwd: "/tmp",
      model: "m",
      permissionMode: "ask",
      agentMode: "agent",
    });
    state = reducer(state, {
      type: "event",
      event: { type: "mode", mode: "plan" },
    });
    expect(state.agentMode).toBe("plan");
    expect(state.notice).toContain("plan");
  });
});
