// Shared headless output contract. The same text / json / stream-json formats
// and the same HeadlessResult schema back every non-interactive entry point, so
// a jq pipeline works against any of them unchanged. These tests drive the
// shared runner with an injectable write sink (no process.stdout monkeypatch)
// and a scripted fake session.

import { describe, expect, it } from "vitest";
import {
  runHeadless,
  parseOutputFormat,
  extractFinalAssistantText,
  countAssistantTurns,
  type Event,
  type HeadlessResult,
  type HeadlessSession,
  type UsageInfo,
} from "../src/index.js";

function makeSession(events: Event[], opts: { throwOnPrompt?: string; usage?: UsageInfo } = {}): HeadlessSession {
  let listener: ((ev: Event) => void) | null = null;
  return {
    id: "sess_abc123",
    subscribe(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    async prompt() {
      for (const ev of events) listener?.(ev);
      if (opts.throwOnPrompt) throw new Error(opts.throwOnPrompt);
      return undefined;
    },
    getUsage() {
      return opts.usage ?? { input: 10, output: 5, costUSD: 0.002 };
    },
    filterToolRegistry() {},
  };
}

function assistantMsg(text: string): Event {
  return { type: "message", id: `m_${text}`, role: "assistant", content: [{ type: "text", text }] } as Event;
}
function userMsg(text: string): Event {
  return { type: "message", id: `u_${text}`, role: "user", content: [{ type: "text", text }] } as Event;
}
const toolCall: Event = { type: "tool_call", id: "t1", name: "read_file", input: {} } as Event;

function capture() {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), lines };
}

describe("parseOutputFormat", () => {
  it("defaults to text", () => {
    expect(parseOutputFormat(undefined)).toBe("text");
    expect(parseOutputFormat("text")).toBe("text");
  });
  it("accepts json and stream-json", () => {
    expect(parseOutputFormat("json")).toBe("json");
    expect(parseOutputFormat("stream-json")).toBe("stream-json");
  });
  it("throws for an unknown format", () => {
    expect(() => parseOutputFormat("yaml")).toThrow(/must be one of/);
  });
});

describe("extractFinalAssistantText / countAssistantTurns", () => {
  it("returns the last non-empty assistant text", () => {
    expect(extractFinalAssistantText([assistantMsg("first"), assistantMsg("last")])).toBe("last");
  });
  it("counts assistant message events", () => {
    expect(countAssistantTurns([userMsg("hi"), assistantMsg("a"), assistantMsg("b")])).toBe(2);
  });
});

describe("runHeadless — text", () => {
  it("emits only the final assistant text", async () => {
    const sink = capture();
    const session = makeSession([userMsg("q"), assistantMsg("the answer")]);
    const r = await runHeadless({ session, prompt: "q", format: "text", write: sink.write });
    expect(sink.lines).toEqual(["the answer\n"]);
    expect(r.subtype).toBe("success");
  });

  it("emits the error message on a prompt throw", async () => {
    const sink = capture();
    const session = makeSession([], { throwOnPrompt: "boom" });
    const r = await runHeadless({ session, prompt: "q", format: "text", write: sink.write });
    expect(sink.lines).toEqual(["boom\n"]);
    expect(r.subtype).toBe("error");
  });
});

describe("runHeadless — json", () => {
  it("emits exactly one rich result object", async () => {
    const sink = capture();
    const session = makeSession([userMsg("q"), toolCall, assistantMsg("done")]);
    const r = await runHeadless({ session, prompt: "q", format: "json", write: sink.write });
    expect(sink.lines.length).toBe(1);
    const obj = JSON.parse(sink.lines[0]!) as HeadlessResult;
    expect(obj.type).toBe("result");
    expect(obj.subtype).toBe("success");
    expect(obj.result).toBe("done");
    expect(obj.session_id).toBe("sess_abc123");
    expect(obj.num_turns).toBe(1);
    expect(obj.had_tool_calls).toBe(true);
    expect(obj.usage.input).toBe(10);
    expect(obj.cost_usd).toBe(0.002);
    expect(obj.duration_ms).toBeGreaterThanOrEqual(0);
    expect(obj.errors).toEqual([]);
    expect(r).toEqual(obj);
  });

  it("recoverable error events are collected but keep subtype success", async () => {
    const sink = capture();
    const errEvent = { type: "error", message: "transient", recoverable: true } as Event;
    const session = makeSession([errEvent, assistantMsg("recovered")]);
    const r = await runHeadless({ session, prompt: "q", format: "json", write: sink.write });
    expect(r.subtype).toBe("success");
    expect(r.errors).toEqual(["transient"]);
    expect(r.result).toBe("recovered");
  });
});

describe("runHeadless — stream-json", () => {
  it("streams one line per event then a closing result", async () => {
    const sink = capture();
    const events = [userMsg("q"), toolCall, assistantMsg("done")];
    const session = makeSession(events);
    await runHeadless({ session, prompt: "q", format: "stream-json", write: sink.write });
    // N event lines + 1 result line, every line valid JSON.
    expect(sink.lines.length).toBe(events.length + 1);
    const parsed = sink.lines.map((l) => JSON.parse(l) as { type: string });
    expect(parsed.slice(0, events.length).map((p) => p.type)).toEqual([
      "message",
      "tool_call",
      "message",
    ]);
    const last = parsed[parsed.length - 1] as HeadlessResult;
    expect(last.type).toBe("result");
    expect(last.subtype).toBe("success");
    expect(last.result).toBe("done");
  });

  it("closing result has subtype error on a prompt throw", async () => {
    const sink = capture();
    const session = makeSession([userMsg("q")], { throwOnPrompt: "nope" });
    await runHeadless({ session, prompt: "q", format: "stream-json", write: sink.write });
    const last = JSON.parse(sink.lines[sink.lines.length - 1]!) as HeadlessResult;
    expect(last.subtype).toBe("error");
    expect(last.result).toBe("nope");
  });
});
