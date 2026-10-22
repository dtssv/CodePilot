// Regression tests for what the model actually sees between turns. The
// agent used to send every tool_use twice and lose all but the first
// tool_result of a turn on OpenAI-compatible providers, which made it
// re-run steps it had already done.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildProgressLedger, isTransientError, runAgent, type AgentDeps } from "../src/agent.js";
import { buildProviderMessages, compactTranscriptToProviderMessages } from "../src/agent-messages.js";
import { compact } from "../src/compaction.js";
import { PermissionEngine } from "../src/permissions.js";
import { buildOpenAIMessages } from "../src/providers/openai.js";
import type { ChatProvider, ProviderMessage, StreamChatOptions, StreamEvent } from "../src/providers/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { Event } from "../src/types.js";

class ScriptedProvider implements ChatProvider {
  readonly name = "scripted";
  defaultModel = "m";
  smallModel = "m";
  calls: StreamChatOptions[] = [];
  constructor(private readonly script: Array<StreamEvent[] | (() => AsyncIterable<StreamEvent>)>) {}
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(structuredClone({ ...opts, signal: undefined, onRetry: undefined }));
    const step = this.script[this.calls.length - 1];
    if (!step) {
      yield { kind: "text_delta", messageId: "x", text: "done" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    if (typeof step === "function") {
      yield* step();
      return;
    }
    for (const ev of step) yield ev;
  }
}

function deps(provider: ChatProvider, extra: Partial<AgentDeps> = {}): { deps: AgentDeps; events: Event[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-transcript-"));
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    inputSchema: z.object({ x: z.string() }),
    permission: "read",
    async execute(input: { x: string }) {
      return { content: `echo:${input.x}` };
    },
  } as never);
  const events: Event[] = [];
  return {
    dir,
    events,
    deps: {
      provider,
      tools,
      artifacts: new ArtifactStore(join(dir, "artifacts")),
      permissions: new PermissionEngine({ permissionMode: "auto-edit" }),
      config: { provider: "anthropic" },
      cwd: dir,
      maxTurns: 6,
      onEvent: (e) => {
        events.push(e);
      },
      ...extra,
    },
  };
}

const call = (id: string, x: string): StreamEvent => ({
  kind: "tool_call",
  messageId: "m",
  toolCall: { type: "tool_use", id, name: "echo", input: { x } },
});

function shape(messages: ProviderMessage[]): string[] {
  return messages.map(
    (m) =>
      `${m.role}:${m.content
        .map((b) => (b.type === "text" ? "text" : b.type === "tool_use" ? `use(${b.id})` : b.type === "tool_result" ? `result(${b.toolCallId})` : b.type))
        .join(",")}`,
  );
}

describe("provider transcript", () => {
  it("sends each tool_use once and every tool_result of a parallel turn", async () => {
    const provider = new ScriptedProvider([
      [{ kind: "text_delta", messageId: "m", text: "looking" }, call("t1", "a"), call("t2", "b"), { kind: "done", finishReason: "tool_use" }],
    ]);
    const { deps: d, dir } = deps(provider);
    await runAgent({ history: [], userText: "go" }, d);
    expect(shape(provider.calls[1]!.messages)).toEqual([
      "user:text",
      "assistant:text,use(t1),use(t2)",
      "user:result(t1),result(t2)",
    ]);
    const results = provider.calls[1]!.messages[2]!.content;
    expect(results.map((b) => (b.type === "tool_result" ? b.content : ""))).toEqual(["echo:a", "echo:b"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers calls that never ran so the next request stays valid", () => {
    const events: Event[] = [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      { type: "tool_call", id: "t1", name: "echo", input: { x: "a" } },
      { type: "message", id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: { x: "a" } }] },
      { type: "error", message: "stream died", recoverable: true },
      { type: "message", id: "u2", role: "user", content: [{ type: "text", text: "try again" }] },
    ];
    const msgs = compactTranscriptToProviderMessages(events, "");
    expect(shape(msgs)).toEqual(["user:text", "assistant:use(t1)", "user:result(t1),text"]);
    const r = msgs[2]!.content[0]!;
    expect(r.type === "tool_result" && r.isError).toBe(true);
  });

  it("drops results whose call is gone (compacted away)", () => {
    const events: Event[] = [
      { type: "compaction", summary: "earlier work" },
      { type: "tool_result", toolCallId: "gone", name: "echo", content: "x" },
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "next" }] },
    ];
    expect(shape(compactTranscriptToProviderMessages(events, ""))).toEqual(["user:text,text"]);
  });

  it("attaches prompt images to the run's own user message", () => {
    const user: Event = { type: "message", id: "u9", role: "user", content: [{ type: "text", text: "see" }] };
    const msgs = buildProviderMessages([], [user], "see", [{ mediaType: "image/png", base64: "AAA" }]);
    expect(shape(msgs)).toEqual(["user:text,image"]);
  });

  it("maps user-side tool results to OpenAI tool messages", () => {
    const out = buildOpenAIMessages(undefined, [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }, { type: "tool_use", id: "t2", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "A" }, { type: "tool_result", toolCallId: "t2", content: "" }] },
    ]) as Array<Record<string, unknown>>;
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(out[2]).toMatchObject({ tool_call_id: "t1", content: "A" });
    expect(out[3]).toMatchObject({ tool_call_id: "t2", content: "(no output)" });
  });
});

describe("turn retry", () => {
  it("regenerates a turn whose stream failed transiently", async () => {
    const provider = new ScriptedProvider([
      async function* () {
        yield { kind: "text_delta", messageId: "m", text: "half an ans" };
        yield { kind: "error", message: "fetch failed: ECONNRESET" };
      },
      [{ kind: "text_delta", messageId: "m", text: "full answer" }, { kind: "done", finishReason: "stop" }],
    ]);
    const { deps: d, events, dir } = deps(provider, { config: { provider: "anthropic", turnRetries: 2 } });
    const t0 = Date.now();
    const r = await runAgent({ history: [], userText: "q" }, d);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    expect(r.finalText).toBe("full answer");
    const retry = events.find((e) => e.type === "retry");
    expect(retry).toMatchObject({ type: "retry", attempt: 1, maxAttempts: 2 });
 // The discarded half answer is not part of the run's transcript.
    expect(r.events.some((e) => e.type === "message_delta" && e.delta.type === "text" && e.delta.text === "half an ans")).toBe(false);
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not retry a non-transient failure", async () => {
    const provider = new ScriptedProvider([[{ kind: "error", message: "OpenAI 400: invalid request" }]]);
    const { deps: d, events, dir } = deps(provider);
    await runAgent({ history: [], userText: "q" }, d);
    expect(provider.calls.length).toBe(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies errors", () => {
    expect(isTransientError("Anthropic 529: overloaded_error")).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError("OpenAI 401: invalid api key")).toBe(false);
  });
});

describe("live context", () => {
  it("lists completed calls so the model does not redo them", () => {
    const ledger = buildProgressLedger([
      { type: "tool_call", id: "1", name: "read_file", input: { path: "src/a.ts" } },
      { type: "tool_result", toolCallId: "1", name: "read_file", content: "x" },
      { type: "tool_call", id: "2", name: "bash", input: { command: "npm test" } },
      { type: "tool_result", toolCallId: "2", name: "bash", content: "fail", isError: true },
      { type: "tool_call", id: "3", name: "read_file", input: { path: "src/a.ts" } },
      { type: "tool_result", toolCallId: "3", name: "read_file", content: "x" },
    ]);
    expect(ledger).toContain("- bash npm test — failed");
    expect(ledger).toContain("- read_file src/a.ts — ok (×2)");
  });

  it("sends the current plan, not the one frozen at prompt start", async () => {
    const provider = new ScriptedProvider([
      [call("t1", "a"), { kind: "done", finishReason: "tool_use" }],
    ]);
    const { deps: d, dir } = deps(provider, {
      systemPrompt: { staticPrefix: "S", dynamicSuffix: "<env/>\n\n<plan>\n(stale)\n</plan>", full: "" },
    });
    const history: Event[] = [{ type: "plan", steps: [{ id: "s1", title: "read code", status: "completed" }] }];
    await runAgent({ history, userText: "go" }, d);
    const last = provider.calls[1]!.messages.at(-1)!;
    const note = last.content
      .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
      .join("");
    expect(note).not.toContain("(stale)");
    expect(note).toContain("[x] s1 — read code");
    expect(note).toContain("- echo — ok");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("doom-loop read cache", () => {
  it("re-reads a file for real after it was edited", async () => {
    const { DoomLoopDetector } = await import("../src/doomLoop.js");
    const d = new DoomLoopDetector();
    d.check("read_file", { path: "a.ts" });
    d.recordResult("read_file", { path: "a.ts" }, { content: "old" });
    expect(d.cachedResult("read_file", { path: "a.ts" })?.content).toBe("old");
    d.noteMutation();
    expect(d.cachedResult("read_file", { path: "a.ts" })).toBeUndefined();
    expect(d.peekCount("read_file", { path: "a.ts" })).toBe(0);
  });
});

describe("compaction", () => {
  it("keeps the latest plan when the turn that wrote it is summarised away", async () => {
    const events: Event[] = [{ type: "plan", steps: [{ id: "p", title: "step", status: "in_progress" }] }];
    const words = (i: number): string => Array.from({ length: 60 }, (_, j) => `word${i}x${j}`).join(" ");
    for (let i = 0; i < 12; i++) {
      events.push({ type: "message", id: `u${i}`, role: "user", content: [{ type: "text", text: words(i) }] });
      events.push({ type: "message", id: `a${i}`, role: "assistant", content: [{ type: "text", text: words(i + 100) }] });
    }
    const summariser: ChatProvider = {
      name: "s",
      defaultModel: "s",
      smallModel: "s",
      async *stream() {
        yield { kind: "text_delta", messageId: "s", text: "SUMMARY" };
        yield { kind: "done", finishReason: "stop" };
      },
    };
    const r = await compact(events, { contextWindow: 100, summariser });
    expect(r.events[0]?.type).toBe("compaction");
    const head = r.events[0];
    expect(head && head.type === "compaction" ? head.summary : "").toMatch(/SUMMARY/);
    expect(r.events.some((e) => e.type === "plan")).toBe(true);
  });
});
