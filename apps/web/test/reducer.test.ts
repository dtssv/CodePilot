// Transcript reducer: events in, rows out.

import { describe, expect, it } from "vitest";

import type { Event } from "@codepilot/core";
import {
  addUsage,
  initialState,
  reducer,
  type Action,
  type AppState,
} from "../src/state/reducer.js";
import type { Row } from "../src/state/rows.js";

function drive(events: Event[], from = initialState("/repo")): AppState {
  return events.reduce(
    (acc, event) => reducer(acc, { type: "event", event }),
    from,
  );
}

function apply(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce((acc, a) => reducer(acc, a), state);
}

const messages = (state: AppState): Extract<Row, { kind: "message" }>[] =>
  state.rows.filter((r): r is Extract<Row, { kind: "message" }> => r.kind === "message");
const tools = (state: AppState): Extract<Row, { kind: "tool" }>[] =>
  state.rows.filter((r): r is Extract<Row, { kind: "tool" }> => r.kind === "tool");

describe("streaming messages", () => {
  it("accumulates deltas into one row and finalises on the message event", () => {
    let state = drive([
      { type: "message_delta", messageId: "m1", delta: { type: "text", text: "Hel" } },
      { type: "message_delta", messageId: "m1", delta: { type: "text", text: "lo" } },
    ]);
    expect(messages(state)).toHaveLength(1);
    expect(messages(state)[0]?.msg).toMatchObject({ text: "Hello", streaming: true });
    expect(state.status).toBe("thinking");

    state = reducer(state, {
      type: "event",
      event: {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        model: "claude-sonnet-4-5",
      },
    });
    expect(messages(state)).toHaveLength(1);
    expect(messages(state)[0]?.msg).toMatchObject({
      text: "Hello",
      streaming: false,
      model: "claude-sonnet-4-5",
    });
    expect(state.model).toBe("claude-sonnet-4-5");
  });

  it("ignores tool-input JSON deltas, which are internal", () => {
    const state = drive([
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "tool_input_json", toolCallId: "t1", partialJson: '{"a":' },
      },
    ]);
    expect(state.rows).toHaveLength(0);
  });

  it("keeps accumulated text when the final message carries none", () => {
    // A tool-only assistant turn has no text blocks; replacing with "" would
    // erase what the user already read.
    let state = drive([
      { type: "message_delta", messageId: "m1", delta: { type: "text", text: "partial" } },
    ]);
    state = reducer(state, {
      type: "event",
      event: { type: "message", id: "m1", role: "assistant", content: [] },
    });
    expect(messages(state)[0]?.msg.text).toBe("partial");
  });

  it("shows the user's prompt once, from the server's echo", () => {
    // `agent.ts` appends the user message to the transcript, so the UI must
    // not also add its own optimistic copy.
    const state = apply(
      initialState("/repo"),
      { type: "sending" },
      {
        type: "event",
        event: {
          type: "message",
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "do the thing" }],
        },
      },
    );
    const userRows = messages(state).filter((r) => r.msg.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.msg.text).toBe("do the thing");
  });
});

describe("tool calls", () => {
  it("pairs a result onto its call and derives a diff for edits", () => {
    let state = drive([
      {
        type: "tool_call",
        id: "t1",
        name: "edit_file",
        input: { path: "a.ts", search: "x", replace: "y" },
      },
    ]);
    expect(tools(state)[0]?.tool.status).toBe("running");
    expect(tools(state)[0]?.tool.change?.path).toBe("a.ts");

    state = reducer(state, {
      type: "event",
      event: {
        type: "tool_result",
        toolCallId: "t1",
        name: "edit_file",
        content: "replaced 1 occurrence",
      },
    });
    expect(tools(state)).toHaveLength(1);
    expect(tools(state)[0]?.tool).toMatchObject({
      status: "ok",
      result: "replaced 1 occurrence",
    });
  });

  it("marks an errored result and keeps the artifact ref", () => {
    const state = drive([
      { type: "tool_call", id: "t1", name: "bash", input: { command: "false" } },
      {
        type: "tool_result",
        toolCallId: "t1",
        name: "bash",
        content: "exit 1",
        isError: true,
        artifactRef: "artifact://1",
      },
    ]);
    expect(tools(state)[0]?.tool).toMatchObject({
      status: "error",
      artifactRef: "artifact://1",
    });
    // Non-mutating tools get no diff view.
    expect(tools(state)[0]?.tool.change).toBeNull();
  });

  it("shows an orphan result rather than dropping it", () => {
    // Resuming mid-turn can deliver a result whose call is not in view.
    const state = drive([
      { type: "tool_result", toolCallId: "gone", name: "grep", content: "3 matches" },
    ]);
    expect(tools(state)[0]?.tool).toMatchObject({
      id: "gone",
      name: "grep",
      status: "ok",
      result: "3 matches",
    });
  });
});

describe("side channels", () => {
  it("tracks plan, usage, compaction and mode rows", () => {
    const state = drive([
      { type: "plan", steps: [{ id: "s1", title: "do it", status: "in_progress" }] },
      { type: "usage", usage: { input: 10, output: 5, costUSD: 0.01 } },
      { type: "usage", usage: { input: 2, output: 1, costUSD: 0.002 } },
      { type: "compaction", summary: "folded 30 events" },
      { type: "mode", mode: "plan" },
    ]);
    expect(state.plan[0]?.title).toBe("do it");
    expect(state.usage).toMatchObject({ input: 12, output: 6 });
    expect(state.usage.costUSD).toBeCloseTo(0.012);
    expect(state.agentMode).toBe("plan");
    expect(state.notice).toBe("mode → plan");
    expect(state.rows.map((r) => r.kind)).toEqual([
      "plan",
      "usage",
      "usage",
      "compaction",
      "mode",
    ]);
  });

  it("renders team_message events as team rows with the event's timestamp", () => {
    const state = drive([
      {
        type: "team_message",
        from: "lead",
        to: "worker-1",
        content: "update the callers",
        timestamp: 1700,
        kind: "assignment",
      },
    ]);
    const row = state.rows[0] as Extract<Row, { kind: "team" }>;
    expect(row.at).toBe(1700);
    expect(row.team).toMatchObject({ from: "lead", to: "worker-1", kind: "assignment" });
  });

  it("defaults a team message with no kind", () => {
    const state = drive([
      { type: "team_message", from: "team", to: "all", content: "hi", timestamp: 1 },
    ]);
    expect((state.rows[0] as Extract<Row, { kind: "team" }>).team.kind).toBe("msg");
  });

  it("surfaces a mode_request as a notice without a row", () => {
    const state = drive([
      { type: "mode_request", mode: "agent", reason: "needs to edit files" },
    ]);
    expect(state.rows).toHaveLength(0);
    expect(state.notice).toMatch(/asked for agent mode: needs to edit files/);
  });
});

describe("status transitions", () => {
  it("returns to idle on a fatal error but not a recoverable one", () => {
    let state = drive([{ type: "status", status: "running" }]);
    expect(state.status).toBe("thinking");
    state = reducer(state, {
      type: "event",
      event: { type: "error", message: "rate limited, retrying", recoverable: true },
    });
    expect(state.status).toBe("thinking");
    state = reducer(state, {
      type: "event",
      event: { type: "error", message: "no api key", recoverable: false },
    });
    expect(state.status).toBe("idle");
  });

  it("does not let a running status close an open dialog", () => {
    // The permission dialog must survive the status events that keep arriving
    // while the agent waits for the answer.
    let state = apply(initialState(), {
      type: "permission",
      req: {
        requestId: "r1",
        sessionId: "s1",
        toolName: "bash",
        input: { command: "rm -rf build" },
        reason: "destructive",
      },
    });
    expect(state.status).toBe("waiting_permission");
    state = reducer(state, { type: "event", event: { type: "status", status: "running" } });
    expect(state.status).toBe("waiting_permission");
    state = apply(state, { type: "permission-resolved" });
    expect(state.permission).toBeUndefined();
    expect(state.status).toBe("thinking");
  });

  it("maps compacting through", () => {
    const state = drive([{ type: "status", status: "compacting" }]);
    expect(state.status).toBe("compacting");
  });
});

describe("connection and sessions", () => {
  it("keeps the transcript when the socket drops", () => {
    // A dropped connection is recoverable; erasing what the user was reading
    // would be worse than showing a stale transcript.
    let state = drive([
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "kept" }],
      },
    ]);
    state = apply(state, { type: "disconnected", error: "closed" });
    expect(state.rows).toHaveLength(1);
    expect(state.connection).toBe("disconnected");
    expect(state.connectionError).toBe("closed");
    expect(state.status).toBe("idle");
  });

  it("replays a resumed session's history through the same code path", () => {
    const history: Event[] = [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "tool_call", id: "t1", name: "read_file", input: { path: "a.ts" } },
      { type: "tool_result", toolCallId: "t1", name: "read_file", content: "contents" },
      { type: "usage", usage: { input: 5, output: 2 } },
    ];
    const state = apply(initialState("/repo"), {
      type: "session-opened",
      sessionId: "s9",
      agentMode: "agent",
      history,
    });
    expect(state.sessionId).toBe("s9");
    expect(messages(state)).toHaveLength(1);
    expect(tools(state)[0]?.tool.status).toBe("ok");
    expect(state.usage).toMatchObject({ input: 5, output: 2 });
  });

  it("clears prior state when a new session opens", () => {
    let state = drive([{ type: "plan", steps: [{ id: "s", title: "old", status: "pending" }] }]);
    state = apply(state, {
      type: "session-opened",
      sessionId: "fresh",
      agentMode: "chat",
    });
    expect(state.rows).toHaveLength(0);
    expect(state.plan).toHaveLength(0);
    expect(state.usage).toEqual({ input: 0, output: 0 });
    expect(state.agentMode).toBe("chat");
  });
});

describe("addUsage", () => {
  it("sums present fields and leaves absent ones absent", () => {
    expect(addUsage({ input: 1, output: 2 }, { input: 3, output: 4 })).toEqual({
      input: 4,
      output: 6,
      cacheRead: undefined,
      cacheWrite: undefined,
      costUSD: undefined,
    });
    expect(
      addUsage({ input: 0, output: 0, cacheRead: 5 }, { input: 0, output: 0 }).cacheRead,
    ).toBe(5);
  });
});
