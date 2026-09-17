import { afterEach, describe, expect, it } from "vitest";
import {
  assertConsistency,
  ConsistencyError,
  consistencyAssertEnabled,
} from "../src/consistency.js";
import type { ContentBlock, Event } from "../src/types.js";
import type { ProviderMessage, ProviderMessageContent } from "../src/providers/types.js";

/** Mirrors contentBlocksToProvider in consistency.ts. */
function contentBlocksToProvider(blocks: ContentBlock[]): ProviderMessageContent[] {
  const out: ProviderMessageContent[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "tool_result")
      out.push({ type: "tool_result", toolCallId: b.toolCallId, content: b.content, isError: b.isError });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textEvent(id: string, role: "user" | "assistant", text: string): Event {
  return { type: "message", id, role, content: [{ type: "text", text }] };
}

function toolCallEvent(id: string, name: string, input: unknown): Event {
  return { type: "tool_call", id, name, input };
}

function toolResultEvent(toolCallId: string, name: string, content: string): Event {
  return { type: "tool_result", toolCallId, name, content };
}

/**
 * Build provider messages that exactly match what assertConsistency derives
 * from the events (mirrors eventsToProviderMessages semantics).
 */
function exactProviderMessages(events: Event[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let buffer: { role: "user" | "assistant"; blocks: ProviderMessage["content"] } | null = null;
  const flush = () => {
    if (buffer && buffer.blocks.length > 0) out.push({ role: buffer.role, content: buffer.blocks });
    buffer = null;
  };
  for (const e of events) {
    if (e.type === "message") {
      flush();
      buffer = { role: e.role, blocks: contentBlocksToProvider(e.content) };
    } else if (e.type === "tool_call") {
      if (!buffer || buffer.role !== "assistant") {
        flush();
        buffer = { role: "assistant", blocks: [] };
      }
      buffer.blocks.push({ type: "tool_use", id: e.id, name: e.name, input: e.input });
    } else if (e.type === "tool_result") {
      flush();
      out.push({
        role: "user",
        content: [{ type: "tool_result", toolCallId: e.toolCallId, content: e.content, isError: e.isError }],
      });
    }
  }
  flush();
  return out;
}

afterEach(() => {
  delete process.env.CODEPILOT_ASSERT_CONSISTENCY;
});

// ---------------------------------------------------------------------------
// consistencyAssertEnabled
// ---------------------------------------------------------------------------

describe("consistencyAssertEnabled", () => {
  it("returns true when CODEPILOT_ASSERT_CONSISTENCY is '1'", () => {
    process.env.CODEPILOT_ASSERT_CONSISTENCY = "1";
    expect(consistencyAssertEnabled()).toBe(true);
  });

  it("returns true when CODEPILOT_ASSERT_CONSISTENCY is 'true'", () => {
    process.env.CODEPILOT_ASSERT_CONSISTENCY = "true";
    expect(consistencyAssertEnabled()).toBe(true);
  });

  it("returns false when the env var is unset", () => {
    delete process.env.CODEPILOT_ASSERT_CONSISTENCY;
    expect(consistencyAssertEnabled()).toBe(false);
  });

  it("returns false for other values", () => {
    for (const v of ["0", "false", "yes", "TRUE", "2", ""]) {
      process.env.CODEPILOT_ASSERT_CONSISTENCY = v;
      expect(consistencyAssertEnabled()).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// assertConsistency
// ---------------------------------------------------------------------------

describe("assertConsistency", () => {
  it("passes when provider messages match events exactly", () => {
    const events: Event[] = [
      textEvent("m1", "user", "hello"),
      textEvent("a1", "assistant", "let me check"),
      toolCallEvent("tc1", "bash", { command: "ls" }),
      toolResultEvent("tc1", "bash", "file1.ts\nfile2.ts"),
      textEvent("a2", "assistant", "done"),
    ];
    const providerMessages = exactProviderMessages(events);
    expect(() => assertConsistency(providerMessages, events)).not.toThrow();
  });

  it("throws ConsistencyError on role mismatch", () => {
    const events: Event[] = [textEvent("m1", "user", "hi"), textEvent("a1", "assistant", "ok")];
    const providerMessages = exactProviderMessages(events);
    // Corrupt the role of the last message.
    providerMessages[providerMessages.length - 1] = {
      role: "user",
      content: providerMessages[providerMessages.length - 1]!.content,
    };
    let err: unknown;
    try {
      assertConsistency(providerMessages, events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConsistencyError);
    expect((err as ConsistencyError).message).toMatch(/Role mismatch/);
    expect((err as ConsistencyError).details.expected).toBe("assistant");
    expect((err as ConsistencyError).details.actual).toBe("user");
  });

  it("throws on block count mismatch", () => {
    const events: Event[] = [
      textEvent("m1", "user", "hi"),
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "tc1", name: "bash", input: { command: "ls" } },
        ],
      },
      toolResultEvent("tc1", "bash", "out"),
    ];
    const providerMessages = exactProviderMessages(events);
    // Remove a block from the assistant message (2 blocks -> 1).
    const assistantIdx = providerMessages.findIndex(
      (m) => m.role === "assistant" && m.content.length > 1
    );
    providerMessages[assistantIdx] = {
      role: "assistant",
      content: providerMessages[assistantIdx]!.content.slice(0, 1),
    };
    let err: unknown;
    try {
      assertConsistency(providerMessages, events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConsistencyError);
    expect((err as ConsistencyError).message).toMatch(/Block count mismatch/);
    expect((err as ConsistencyError).details.expected).toBe(2);
    expect((err as ConsistencyError).details.actual).toBe(1);
  });

  it("throws on text content mismatch", () => {
    const events: Event[] = [textEvent("m1", "user", "hi"), textEvent("a1", "assistant", "hello world")];
    const providerMessages = exactProviderMessages(events);
    providerMessages[providerMessages.length - 1] = {
      role: "assistant",
      content: [{ type: "text", text: "tampered text" }],
    };
    let err: unknown;
    try {
      assertConsistency(providerMessages, events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConsistencyError);
    expect((err as ConsistencyError).message).toMatch(/Text mismatch/);
    expect((err as ConsistencyError).details.expected).toBe("hello world");
    expect((err as ConsistencyError).details.actual).toBe("tampered text");
  });

  it("throws on tool_use id/name mismatch", () => {
    const events: Event[] = [
      textEvent("m1", "user", "hi"),
      textEvent("a1", "assistant", "calling tool"),
      toolCallEvent("tc1", "bash", { command: "ls" }),
      toolResultEvent("tc1", "bash", "out"),
    ];
    const providerMessages = exactProviderMessages(events);
    // Find the tool_use block and corrupt its name.
    const assistant = providerMessages.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use")
    )!;
    assistant.content = assistant.content.map((b) =>
      b.type === "tool_use" ? { ...b, name: "read_file" } : b
    );
    let err: unknown;
    try {
      assertConsistency(providerMessages, events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConsistencyError);
    expect((err as ConsistencyError).message).toMatch(/Tool-use id\/name mismatch/);
    expect((err as ConsistencyError).details.expected).toBe("bash(tc1)");
    expect((err as ConsistencyError).details.actual).toBe("read_file(tc1)");
  });

  it("throws on tool_use input mismatch", () => {
    const events: Event[] = [
      textEvent("m1", "user", "hi"),
      textEvent("a1", "assistant", "calling tool"),
      toolCallEvent("tc1", "bash", { command: "ls" }),
      toolResultEvent("tc1", "bash", "out"),
    ];
    const providerMessages = exactProviderMessages(events);
    const assistant = providerMessages.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use")
    )!;
    assistant.content = assistant.content.map((b) =>
      b.type === "tool_use" ? { ...b, input: { command: "rm -rf /" } } : b
    );
    let err: unknown;
    try {
      assertConsistency(providerMessages, events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConsistencyError);
    expect((err as ConsistencyError).message).toMatch(/Tool-use input mismatch/);
    expect((err as ConsistencyError).details.expected).toBe(JSON.stringify({ command: "ls" }));
    expect((err as ConsistencyError).details.actual).toBe(JSON.stringify({ command: "rm -rf /" }));
  });

  it("throws on tool_result content mismatch", () => {
    const events: Event[] = [
      textEvent("m1", "user", "hi"),
      textEvent("a1", "assistant", "calling tool"),
      toolCallEvent("tc1", "bash", { command: "ls" }),
      toolResultEvent("tc1", "bash", "original output"),
    ];
    const providerMessages = exactProviderMessages(events);
    const toolResultMsg = providerMessages.find((m) =>
      m.content.some((b) => b.type === "tool_result")
    )!;
    toolResultMsg.content = toolResultMsg.content.map((b) =>
      b.type === "tool_result" ? { ...b, content: "tampered output" } : b
    );
    let err: unknown;
    try {
      assertConsistency(providerMessages, events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConsistencyError);
    expect((err as ConsistencyError).message).toMatch(/Tool-result content mismatch/);
    expect((err as ConsistencyError).details.expected).toBe("original output");
    expect((err as ConsistencyError).details.actual).toBe("tampered output");
  });

  it("allows folded head to differ (only checks tail)", () => {
    // Build a long transcript so the head is outside the checked tail window.
    const events: Event[] = [];
    for (let i = 0; i < 12; i++) {
      events.push(textEvent(`m${i}`, "user", `prompt ${i}`));
      events.push(textEvent(`a${i}`, "assistant", `answer ${i}`));
      events.push(toolCallEvent(`tc${i}`, "bash", { command: `ls ${i}` }));
      events.push(toolResultEvent(`tc${i}`, "bash", `output ${i}`));
    }
    const providerMessages = exactProviderMessages(events);
    // Simulate micro-compaction: fold the oldest tool_result into a stub.
    // This is outside the tail window and must NOT trigger an error.
    const firstToolResult = providerMessages.find((m) =>
      m.content.some((b) => b.type === "tool_result")
    )!;
    firstToolResult.content = firstToolResult.content.map((b) =>
      b.type === "tool_result" ? { ...b, content: "[folded]" } : b
    );
    expect(() => assertConsistency(providerMessages, events)).not.toThrow();

    // Sanity: corrupting the TAIL should still throw.
    const tail = providerMessages[providerMessages.length - 1]!;
    tail.content = [{ type: "text", text: "tampered tail" }];
    expect(() => assertConsistency(providerMessages, events)).toThrow(ConsistencyError);
  });
});

// ---------------------------------------------------------------------------
// ConsistencyError
// ---------------------------------------------------------------------------

describe("ConsistencyError", () => {
  it("has correct name, message, and details", () => {
    const details = { expected: "a", actual: "b", context: "tail[0]" };
    const err = new ConsistencyError("something diverged", details);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConsistencyError");
    expect(err.message).toBe("something diverged");
    expect(err.details).toEqual(details);
    expect(err.details.context).toBe("tail[0]");
  });
});
