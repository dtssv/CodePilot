import { describe, expect, it, vi } from "vitest";
import type { Event, Session, UsageInfo } from "@codepilot/core";
import {
  runHeadless,
  parseOutputFormat,
  type HeadlessResult,
} from "../src/headless.js";

/** Build a minimal mock Session that replays a scripted event sequence when
 *  `prompt()` is called, then resolves. The events are emitted via subscribe
 *  + getEvents so headless.ts sees them exactly as a real session would. */
function makeMockSession(opts: {
  id?: string;
  events: Event[];
  usage?: UsageInfo;
  promptError?: Error;
}): Session {
  const id = opts.id ?? "sess_test";
  const usage: UsageInfo = opts.usage ?? { input: 100, output: 50 };
  const listeners = new Set<(e: Event) => void>();
  const emitted: Event[] = [];
  const session = {
    id,
    cwd: "/tmp",
    subscribe(fn: (e: Event) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getEvents() {
      return emitted.slice();
    },
    getUsage() {
      return usage;
    },
    async prompt(_text: string) {
      if (opts.promptError) throw opts.promptError;
      for (const ev of opts.events) {
        emitted.push(ev);
        for (const l of listeners) l(ev);
      }
    },
    async dispose() {},
  };
  return session as unknown as Session;
}

function assistantMessage(text: string): Event {
  return {
    type: "message",
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    content: [{ type: "text", text }],
  };
}
function userMessage(text: string): Event {
  return {
    type: "message",
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: "user",
    content: [{ type: "text", text }],
  };
}
function toolCall(id: string, name: string): Event {
  return { type: "tool_call", id, name, input: {} };
}
function toolResult(id: string): Event {
  return { type: "tool_result", toolCallId: id, name: "read_file", content: "ok" };
}
function errorEvent(message: string): Event {
  return { type: "error", message, recoverable: true };
}

// Capture stdout writes so we can assert on output without polluting the
// terminal. We monkeypatch process.stdout.write for the duration of each test.
function captureStdout<T>(fn: () => Promise<T>): { output: string; result: T } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  let result: T;
  return fn()
    .then((r) => {
      result = r;
      (process.stdout as { write: unknown }).write = original;
      return { output: chunks.join(""), result: result! };
    })
    .catch((err) => {
      (process.stdout as { write: unknown }).write = original;
      throw err;
    });
}

describe("parseOutputFormat", () => {
  it("accepts text (default when undefined)", () => {
    expect(parseOutputFormat(undefined)).toBe("text");
    expect(parseOutputFormat("text")).toBe("text");
  });

  it("accepts json and stream-json", () => {
    expect(parseOutputFormat("json")).toBe("json");
    expect(parseOutputFormat("stream-json")).toBe("stream-json");
  });

  it("throws for invalid values", () => {
    expect(() => parseOutputFormat("yaml")).toThrow(/must be one of/);
    expect(() => parseOutputFormat("XML")).toThrow(/must be one of/);
  });
});

describe("runHeadless — text format", () => {
  it("writes the final assistant text to stdout", async () => {
    const session = makeMockSession({
      events: [
        userMessage("hello"),
        assistantMessage("Hello! How can I help?"),
      ],
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "hello", format: "text" })
    );
    expect(output.trim()).toBe("Hello! How can I help?");
  });

  it("uses the LAST assistant message when there are several", async () => {
    const session = makeMockSession({
      events: [
        assistantMessage("first"),
        assistantMessage("second"),
        assistantMessage("final answer"),
      ],
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "text" })
    );
    expect(output.trim()).toBe("final answer");
  });

  it("outputs empty string when no assistant message was produced", async () => {
    const session = makeMockSession({ events: [userMessage("x")] });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "text" })
    );
    expect(output.trim()).toBe("");
  });
});

describe("runHeadless — json format", () => {
  it("emits a single result JSON object with the final text", async () => {
    const session = makeMockSession({
      id: "sess_abc",
      events: [
        userMessage("hi"),
        assistantMessage("Hello there."),
      ],
      usage: { input: 10, output: 5, costUSD: 0.001 },
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "hi", format: "json" })
    );
    const parsed = JSON.parse(output.trim()) as HeadlessResult;
    expect(parsed.type).toBe("result");
    expect(parsed.subtype).toBe("success");
    expect(parsed.result).toBe("Hello there.");
    expect(parsed.session_id).toBe("sess_abc");
    expect(parsed.num_turns).toBe(1);
    expect(parsed.had_tool_calls).toBe(false);
    expect(parsed.usage.input).toBe(10);
    expect(parsed.cost_usd).toBe(0.001);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
    expect(parsed.errors).toEqual([]);
  });

  it("marks subtype as error when the prompt throws", async () => {
    const session = makeMockSession({
      events: [],
      promptError: new Error("API down"),
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "json" })
    );
    const parsed = JSON.parse(output.trim()) as HeadlessResult;
    expect(parsed.subtype).toBe("error");
    expect(parsed.result).toContain("API down");
    expect(parsed.errors).toContain("API down");
  });

  it("counts tool calls in had_tool_calls", async () => {
    const session = makeMockSession({
      events: [
        assistantMessage("let me check"),
        toolCall("tc1", "read_file"),
        toolResult("tc1"),
        assistantMessage("done"),
      ],
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "json" })
    );
    const parsed = JSON.parse(output.trim()) as HeadlessResult;
    expect(parsed.had_tool_calls).toBe(true);
    expect(parsed.num_turns).toBe(2);
  });

  it("emits exactly one JSON object (one line)", async () => {
    const session = makeMockSession({ events: [assistantMessage("ok")] });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "json" })
    );
    const lines = output.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
});

describe("runHeadless — stream-json format", () => {
  it("emits one NDJSON line per event plus a final result line", async () => {
    const events: Event[] = [
      userMessage("hi"),
      assistantMessage("Hello!"),
    ];
    const session = makeMockSession({ id: "sess_s", events });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "hi", format: "stream-json" })
    );
    const lines = output.trim().split("\n");
    // 2 scripted events + 1 final result envelope
    expect(lines.length).toBe(3);
    const first = JSON.parse(lines[0]!) as Event;
    expect(first.type).toBe("message");
    expect(first.role).toBe("user");
    const second = JSON.parse(lines[1]!) as Event;
    expect(second.type).toBe("message");
    expect(second.role).toBe("assistant");
    const finalLine = JSON.parse(lines[2]!) as HeadlessResult;
    expect(finalLine.type).toBe("result");
    expect(finalLine.subtype).toBe("success");
    expect(finalLine.result).toBe("Hello!");
    expect(finalLine.session_id).toBe("sess_s");
  });

  it("includes tool_call and tool_result events as separate lines", async () => {
    const events: Event[] = [
      toolCall("tc1", "read_file"),
      toolResult("tc1"),
      assistantMessage("done"),
    ];
    const session = makeMockSession({ events });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "stream-json" })
    );
    const lines = output.trim().split("\n");
    // 3 events + 1 result = 4 lines
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0]!).type).toBe("tool_call");
    expect(JSON.parse(lines[1]!).type).toBe("tool_result");
    expect(JSON.parse(lines[2]!).role).toBe("assistant");
    expect(JSON.parse(lines[3]!).type).toBe("result");
  });

  it("each line is valid JSON on its own (NDJSON)", async () => {
    const session = makeMockSession({
      events: [assistantMessage('text with "quotes" and \n newlines')],
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "stream-json" })
    );
    const lines = output.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("marks the result line as error when prompt throws", async () => {
    const session = makeMockSession({
      events: [],
      promptError: new Error("boom"),
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "stream-json" })
    );
    const lines = output.trim().split("\n");
    const finalLine = JSON.parse(lines[lines.length - 1]!) as HeadlessResult;
    expect(finalLine.subtype).toBe("error");
    expect(finalLine.result).toContain("boom");
  });
});

describe("runHeadless — error events are collected", () => {
  it("json result includes recoverable errors in the errors array", async () => {
    const session = makeMockSession({
      events: [
        errorEvent("transient stream error"),
        assistantMessage("recovered"),
      ],
    });
    const { output } = await captureStdout(() =>
      runHeadless({ session, prompt: "x", format: "json" })
    );
    const parsed = JSON.parse(output.trim()) as HeadlessResult;
    expect(parsed.errors).toContain("transient stream error");
    // recoverable errors don't flip the subtype to error
    expect(parsed.subtype).toBe("success");
    expect(parsed.result).toBe("recovered");
  });
});
