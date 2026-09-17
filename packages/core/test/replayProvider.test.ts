import { describe, expect, it } from "vitest";
import { ReplayProvider, extractReplayTurns } from "../src/replayProvider.js";
import type { ContentBlock, Event, ToolUseBlock } from "../src/types.js";
import type { StreamChatOptions, StreamEvent } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMessage(text: string): Event {
  return {
    type: "message",
    id: `user_${text}`,
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistantMessage(id: string, content: ContentBlock[]): Event {
  return { type: "message", id, role: "assistant", content };
}

function toolUseBlock(id: string, name: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function toolResultEvent(toolCallId: string): Event {
  return {
    type: "tool_result",
    toolCallId,
    name: "some_tool",
    content: "tool output",
  };
}

const STREAM_OPTS: StreamChatOptions = {
  model: "replay-model",
  messages: [],
};

async function collectStream(provider: ReplayProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of provider.stream(STREAM_OPTS)) {
    events.push(e);
  }
  return events;
}

/** Build a provider from raw JSONL text (load is synchronous for raw text). */
function providerFromEvents(events: Event[]): ReplayProvider {
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
  return new ReplayProvider(jsonl, { isRawText: true });
}

// ---------------------------------------------------------------------------
// extractReplayTurns
// ---------------------------------------------------------------------------

describe("extractReplayTurns", () => {
  it("extracts assistant messages with text blocks", () => {
    const events: Event[] = [
      assistantMessage("a1", [
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ]),
    ];
    const turns = extractReplayTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].textBlocks).toEqual(["Hello", "World"]);
    expect(turns[0].toolCalls).toEqual([]);
    expect(turns[0].usage).toEqual({ input: 0, output: 0 });
  });

  it("extracts assistant messages with tool_use blocks", () => {
    const toolCall = toolUseBlock("tc1", "read_file", { path: "/tmp/x" });
    const events: Event[] = [
      assistantMessage("a1", [{ type: "text", text: "Reading file" }, toolCall]),
    ];
    const turns = extractReplayTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].textBlocks).toEqual(["Reading file"]);
    expect(turns[0].toolCalls).toEqual([toolCall]);
  });

  it("skips user messages", () => {
    const events: Event[] = [
      userMessage("hi there"),
      assistantMessage("a1", [{ type: "text", text: "response" }]),
      userMessage("follow up"),
    ];
    const turns = extractReplayTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].textBlocks).toEqual(["response"]);
  });

  it("skips empty assistant messages", () => {
    const events: Event[] = [
      assistantMessage("empty", []),
      assistantMessage("a1", [{ type: "text", text: "real content" }]),
    ];
    const turns = extractReplayTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].textBlocks).toEqual(["real content"]);
  });

  it("skips tool_result events", () => {
    const events: Event[] = [
      assistantMessage("a1", [toolUseBlock("tc1", "bash", { command: "ls" })]),
      toolResultEvent("tc1"),
      assistantMessage("a2", [{ type: "text", text: "done" }]),
    ];
    const turns = extractReplayTurns(events);
    expect(turns).toHaveLength(2);
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[1].textBlocks).toEqual(["done"]);
  });
});

// ---------------------------------------------------------------------------
// ReplayProvider
// ---------------------------------------------------------------------------

describe("ReplayProvider", () => {
  it("replays turns in order via stream()", async () => {
    const provider = providerFromEvents([
      assistantMessage("a1", [{ type: "text", text: "first" }]),
      assistantMessage("a2", [{ type: "text", text: "second" }]),
    ]);

    const first = await collectStream(provider);
    const second = await collectStream(provider);

    const firstText = first
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""));
    const secondText = second
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""));
    expect(firstText).toEqual(["first"]);
    expect(secondText).toEqual(["second"]);
    expect(first[0]).toMatchObject({ messageId: "replay_0" });
    expect(second[0]).toMatchObject({ messageId: "replay_1" });
  });

  it("emits text_delta events for text blocks", async () => {
    const provider = providerFromEvents([
      assistantMessage("a1", [
        { type: "text", text: "chunk one" },
        { type: "text", text: "chunk two" },
      ]),
    ]);
    const events = await collectStream(provider);
    const deltas = events.filter((e) => e.kind === "text_delta");
    expect(deltas).toEqual([
      { kind: "text_delta", messageId: "replay_0", text: "chunk one" },
      { kind: "text_delta", messageId: "replay_0", text: "chunk two" },
    ]);
  });

  it("emits tool_call events for tool_use blocks", async () => {
    const tc1 = toolUseBlock("tc1", "read_file", { path: "/a" });
    const tc2 = toolUseBlock("tc2", "bash", { command: "pwd" });
    const provider = providerFromEvents([assistantMessage("a1", [tc1, tc2])]);
    const events = await collectStream(provider);
    const toolCalls = events.filter((e) => e.kind === "tool_call");
    expect(toolCalls).toEqual([
      { kind: "tool_call", messageId: "replay_0", toolCall: tc1 },
      { kind: "tool_call", messageId: "replay_0", toolCall: tc2 },
    ]);
  });

  it("emits usage and done events", async () => {
    const provider = providerFromEvents([
      assistantMessage("a1", [{ type: "text", text: "hi" }]),
    ]);
    const events = await collectStream(provider);
    const usage = events.find((e) => e.kind === "usage");
    const done = events.find((e) => e.kind === "done");
    expect(usage).toEqual({ kind: "usage", usage: { input: 0, output: 0 } });
    expect(done).toEqual({ kind: "done", finishReason: "stop" });
    // usage and done come after all content events
    expect(events[events.length - 2].kind).toBe("usage");
    expect(events[events.length - 1].kind).toBe("done");
  });

  it('emits "(replay transcript exhausted)" when cursor exceeds turns', async () => {
    const provider = providerFromEvents([
      assistantMessage("a1", [{ type: "text", text: "only turn" }]),
    ]);
    await collectStream(provider); // consume the single turn
    const exhausted = await collectStream(provider);
    expect(exhausted).toEqual([
      {
        kind: "text_delta",
        messageId: "replay_1",
        text: "(replay transcript exhausted)",
      },
      { kind: "usage", usage: { input: 0, output: 0 } },
      { kind: "done", finishReason: "stop" },
    ]);
  });

  it("reset() allows re-replaying", async () => {
    const provider = providerFromEvents([
      assistantMessage("a1", [{ type: "text", text: "again" }]),
    ]);
    await collectStream(provider);
    provider.reset();
    const events = await collectStream(provider);
    const deltas = events.filter((e) => e.kind === "text_delta");
    expect(deltas).toEqual([
      { kind: "text_delta", messageId: "replay_0", text: "again" },
    ]);
  });

  it("turnCount() returns correct count", () => {
    const provider = providerFromEvents([
      userMessage("q1"),
      assistantMessage("a1", [{ type: "text", text: "one" }]),
      toolResultEvent("tc1"),
      assistantMessage("a2", [toolUseBlock("tc2", "bash", { command: "ls" })]),
      assistantMessage("empty", []),
    ]);
    expect(provider.turnCount()).toBe(2);
  });

  it("handles malformed JSONL lines gracefully", async () => {
    const good = JSON.stringify(
      assistantMessage("a1", [{ type: "text", text: "survives" }])
    );
    const jsonl = [
      good,
      "{not valid json",
      "",
      "   ",
      '{"type":"message"', // truncated
      good,
    ].join("\n");
    const provider = new ReplayProvider(jsonl, { isRawText: true });
    expect(provider.turnCount()).toBe(2);
    const events = await collectStream(provider);
    const deltas = events.filter((e) => e.kind === "text_delta");
    expect(deltas).toEqual([
      { kind: "text_delta", messageId: "replay_0", text: "survives" },
    ]);
  });

  it('finishReason is "tool_use" when turn has tool calls, "stop" otherwise', async () => {
    const provider = providerFromEvents([
      assistantMessage("a1", [toolUseBlock("tc1", "bash", { command: "ls" })]),
      assistantMessage("a2", [{ type: "text", text: "plain text" }]),
      assistantMessage("a3", [
        { type: "text", text: "mixed" },
        toolUseBlock("tc2", "read_file", { path: "/x" }),
      ]),
    ]);

    const doneOf = (events: StreamEvent[]) =>
      events.find((e) => e.kind === "done");

    expect(doneOf(await collectStream(provider))).toEqual({
      kind: "done",
      finishReason: "tool_use",
    });
    expect(doneOf(await collectStream(provider))).toEqual({
      kind: "done",
      finishReason: "stop",
    });
    expect(doneOf(await collectStream(provider))).toEqual({
      kind: "done",
      finishReason: "tool_use",
    });
  });
});
