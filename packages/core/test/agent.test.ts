import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAgent,
  hasUnfinishedPlan,
  isWaitingForUser,
  looksLikeIncompleteTurn,
} from "../src/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import { z } from "zod";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "../src/providers/types.js";
import type { AgentDeps } from "../src/agent.js";
import type { Event } from "../src/types.js";

class MockProvider implements ChatProvider {
  readonly name = "mock";
  defaultModel = "mock-large";
  smallModel = "mock-small";
 /** Recorded plans of events to emit, in order. */
  responses: StreamEvent[][] = [];
 /** Recorded stream options. */
  calls: StreamChatOptions[] = [];
  private idx = 0;

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    const i = this.idx++;
    if (i >= this.responses.length) {
      yield { kind: "text_delta", messageId: "m", text: "(no more responses)" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    for (const ev of this.responses[i]!) yield ev;
  }
}

function makeTool(
  name: string,
  perm: "read" | "write" | "execute" | "network",
  output: string
) {
  return {
    name,
    description: `mock ${name}`,
    inputSchema: z.object({ x: z.string() }),
    permission: perm,
    async execute() {
      return { content: output };
    },
  };
}

function makeDeps(cwd: string, provider: MockProvider, autoEdit = true) {
  const tools = new ToolRegistry();
  const echo = makeTool("echo", "read", "echoed!");
  tools.register(echo);
  const artifacts = new ArtifactStore(join(cwd, ".codepilot", "artifacts"));
  return {
    artifacts,
    permissions: new PermissionEngine({ permissionMode: autoEdit ? "auto-edit" : "ask" }),
    deps(): AgentDeps {
      return {
        provider,
        tools,
        artifacts: this.artifacts,
        permissions: this.permissions,
        config: { provider: "anthropic" },
        cwd,
        maxTurns: 5,
      };
    },
  };
}

describe("runAgent maxTurns (unset = unlimited)", () => {
  it("does not cap turns when maxTurns is unset (unlimited)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // 8 tool turns then a final text reply — would fail under the old default of 50
    // only if we somehow defaulted low; here we assert unset allows many loops.
    provider.responses = [];
    for (let i = 0; i < 8; i++) {
      provider.responses.push([
        {
          kind: "tool_call",
          messageId: `m${i}`,
          toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } },
        },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    provider.responses.push([
      { kind: "text_delta", messageId: "done", text: "finished" },
      { kind: "done", finishReason: "stop" },
    ]);
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    const r = await runAgent({ history: [], userText: "long task" }, deps);
    expect(provider.calls.length).toBe(9);
    expect(r.finalText).toBe("finished");
    expect(r.events.some((e) => e.type === "error" && /maxTurns/i.test(e.message))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a recoverable error when a configured maxTurns cap is hit mid-tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "1" } },
        },
        { kind: "done", finishReason: "stop" },
      ],
      [
        {
          kind: "tool_call",
          messageId: "m2",
          toolCall: { type: "tool_use", id: "t2", name: "echo", input: { x: "2" } },
        },
        { kind: "done", finishReason: "stop" },
      ],
      [
        {
          kind: "tool_call",
          messageId: "m3",
          toolCall: { type: "tool_use", id: "t3", name: "echo", input: { x: "3" } },
        },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const deps = { ...f.deps(), maxTurns: 2 };
    const r = await runAgent({ history: [], userText: "go" }, deps);
    expect(provider.calls.length).toBe(2);
    const err = r.events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.recoverable).toBe(true);
    expect(err && err.type === "error" && err.message).toMatch(/maxTurns \(2\)/);
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runAgent (mock provider)", () => {
  it("runs a single turn with no tool calls and returns the final text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        { kind: "text_delta", messageId: "m1", text: "hi " },
        { kind: "text_delta", messageId: "m1", text: "there" },
        { kind: "usage", usage: { input: 10, output: 5 } },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const r = await runAgent({ history: [], userText: "hello" }, f.deps());
    expect(r.finalText).toBe("hi there");
    expect(r.hadToolCalls).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs tool calls and loops until no more tool calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "y" } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "done" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const r = await runAgent({ history: [], userText: "go" }, f.deps());
    expect(r.finalText).toBe("done");
    expect(r.hadToolCalls).toBe(true);
    expect(provider.calls.length).toBe(2);
 // After the first turn the tool result should be present in the second
 // call's messages.
    const secondCallMessages = provider.calls[1]!.messages;
    const toolResults = secondCallMessages
      .flatMap((m) => m.content)
      .filter((c) => c.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not resend the prompt when the host appends events to the history it passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "y" } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "done" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
 // Like Session: the live transcript doubles as the run's history.
    const transcript: Event[] = [];
    await runAgent(
      { history: transcript, userText: "ask me once" },
      { ...f.deps(), onEvent: (e) => void transcript.push(e) },
    );
    const roles = provider.calls[1]!.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    const prompts = provider.calls[1]!.messages
      .flatMap((m) => m.content)
      .filter((c) => c.type === "text" && c.text.includes("ask me once"));
    expect(prompts).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [["completed", "in_progress"], ["completed", "completed"]],
    [["in_progress", "pending"], null],
  ])("closes a finished plan when the run ends (%j)", async (before, after) => {
    const { planUpdateTool } = await import("../src/tools/plan_update.js");
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    const steps = before.map((status, i) => ({ id: String(i + 1), title: `step ${i + 1}`, status }));
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "p1", name: "plan_update", input: { steps } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "here is the report" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    deps.tools.register(planUpdateTool);
    const r = await runAgent({ history: [], userText: "go" }, deps);
    const plans = r.events.filter((e): e is Extract<Event, { type: "plan" }> => e.type === "plan");
    const last = plans[plans.length - 1]!;
    expect(last.steps.map((s) => s.status)).toEqual(after ?? before);
    expect(plans).toHaveLength(after ? 2 : 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("respects abort signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    const controller = new AbortController();
    controller.abort();
    provider.responses = [];
    const f = makeDeps(dir, provider);
    const r = await runAgent({ history: [], userText: "go" }, { ...f.deps(), signal: controller.signal });
    expect(r.finalText).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not emit an error row when the stream is aborted mid-turn (Stop)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const controller = new AbortController();
    const provider: ChatProvider = {
      name: "mock-abort",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(_opts) {
        yield { kind: "text_delta", messageId: "m", text: "partial" };
        controller.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      },
    };
    const events: Event[] = [];
    const f = makeDeps(dir, new MockProvider());
    await runAgent(
      { history: [], userText: "go" },
      {
        ...f.deps(),
        provider,
        signal: controller.signal,
        onEvent: (e) => {
          events.push(e);
        },
      },
    );
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits status events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [[{ kind: "done", finishReason: "stop" }]];
    const f = makeDeps(dir, provider);
    const events: import("../src/types.js").Event[] = [];
    const r = await runAgent(
      { history: [], userText: "go" },
      { ...f.deps(), onEvent: (e) => { events.push(e); } }
    );
    const statuses = events.filter((e) => e.type === "status") as Array<{ type: "status"; status: string }>;
    expect(statuses.some((s) => s.status === "running")).toBe(true);
    expect(statuses.some((s) => s.status === "idle")).toBe(true);
    void r;
    rmSync(dir, { recursive: true, force: true });
  });

  it("spills large tool results to an artifact so fold stubs stay recoverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    const tools = new ToolRegistry();
    tools.register(makeTool("echo", "read", "x".repeat(2000)));
    const artifacts = new ArtifactStore(join(dir, ".codepilot", "artifacts"));
    const permissions = new PermissionEngine({ permissionMode: "auto-edit" });
    const deps: AgentDeps = {
      provider,
      tools,
      artifacts,
      permissions,
      config: { provider: "anthropic" },
      cwd: dir,
      maxTurns: 5,
    };
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "y" } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "done" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const events: import("../src/types.js").Event[] = [];
    await runAgent(
      { history: [], userText: "go" },
      { ...deps, onEvent: (e) => { events.push(e); } }
    );
    const tr = events.find((e) => e.type === "tool_result") as
      | { type: "tool_result"; artifactRef?: string; content: string }
      | undefined;
    expect(tr).toBeDefined();
 // >400 chars with no tool-provided ref → agent attached one.
    expect(tr!.content.length).toBeGreaterThan(400);
    expect(tr!.artifactRef).toMatch(/^art_[a-f0-9]+$/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves small tool results without an artifactRef", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "y" } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [{ kind: "done", finishReason: "stop" }],
    ];
    const f = makeDeps(dir, provider);
    const events: import("../src/types.js").Event[] = [];
    await runAgent(
      { history: [], userText: "go" },
      { ...f.deps(), onEvent: (e) => { events.push(e); } }
    );
    const tr = events.find((e) => e.type === "tool_result") as
      | { type: "tool_result"; artifactRef?: string; content: string }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.content).toBe("echoed!");
    expect(tr!.artifactRef).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

vi.restoreAllMocks();

describe("runAgent output-token truncation", () => {
  it("resumes a reply cut off by the length limit instead of ending the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        { kind: "text_delta", messageId: "m1", text: "part one, " },
        { kind: "done", finishReason: "length" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "part two" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const r = await runAgent({ history: [], userText: "write a lot" }, f.deps());
    expect(provider.calls.length).toBe(2);
    expect(r.finalText).toBe("part one, part two");
    const last = provider.calls[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("cut off by the output-token limit");
 // The resume prompt is provider-only; the transcript never shows it.
    expect(r.events.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives up resuming after a bounded number of truncated replies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    const cut: StreamEvent[] = [
      { kind: "text_delta", messageId: "m", text: "x" },
      { kind: "done", finishReason: "max_tokens" },
    ];
    provider.responses = [cut, cut, cut, cut, cut, cut];
    const f = makeDeps(dir, provider);
    const deps = { ...f.deps(), maxTurns: 10 };
    const r = await runAgent({ history: [], userText: "go" }, deps);
    expect(provider.calls.length).toBe(4);
    expect(r.finalText).toBe("xxxx");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not execute a tool call whose arguments were cut off, and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    const execute = vi.fn(async () => ({ content: "ran" }));
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { __raw: '{"x": "unfinished' } },
        },
        { kind: "done", finishReason: "length" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "ok" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    deps.tools.get("echo")!.execute = execute;
    const r = await runAgent({ history: [], userText: "go" }, deps);
    expect(execute).not.toHaveBeenCalled();
    const res = r.events.find((e) => e.type === "tool_result");
    expect(res && res.type === "tool_result" && res.isError).toBe(true);
    expect(res && res.type === "tool_result" && res.content).toMatch(/cut off by the output-token limit.*NOT executed/s);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runAgent plan-only turns", () => {
  const planCall = (id: string): StreamEvent => ({
    kind: "tool_call",
    messageId: id,
    toolCall: { type: "tool_use", id, name: "plan_update", input: { x: "" } },
  });
  const finish: StreamEvent[] = [
    { kind: "text_delta", messageId: "m9", text: "done" },
    { kind: "done", finishReason: "stop" },
  ];

  it("nudges the model when a response carries nothing but plan_update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [[planCall("p1"), { kind: "done", finishReason: "tool_use" }], finish];
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    deps.tools.register(makeTool("plan_update", "read", "plan saved"));
    const r = await runAgent({ history: [], userText: "go" }, deps);
    const res = r.events.find((e) => e.type === "tool_result");
    expect(res && res.type === "tool_result" && res.content).toMatch(/^plan saved\n\nNote: .*same response/s);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves plan_update alone when it is batched with real work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        planCall("p1"),
        { kind: "tool_call", messageId: "p1", toolCall: { type: "tool_use", id: "e1", name: "echo", input: { x: "" } } },
        { kind: "done", finishReason: "tool_use" },
      ],
      finish,
    ];
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    deps.tools.register(makeTool("plan_update", "read", "plan saved"));
    const r = await runAgent({ history: [], userText: "go" }, deps);
    const res = r.events.find((e) => e.type === "tool_result" && e.name === "plan_update");
    expect(res && res.type === "tool_result" && res.content).toBe("plan saved");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("soft-stop resume (empty / unfinished plan)", () => {
  it("auto-continues once after an empty stop following tool use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "1" } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      // Empty successful stop — should resume, not idle.
      [{ kind: "done", finishReason: "stop" }],
      [
        { kind: "text_delta", messageId: "m3", text: "resumed and done" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const r = await runAgent({ history: [], userText: "go" }, f.deps());
    expect(provider.calls.length).toBe(3);
    const resumeMsg = provider.calls[2]!.messages
      .flatMap((m) => m.content)
      .find((c) => c.type === "text" && c.text.includes("no visible final text"));
    expect(resumeMsg).toBeTruthy();
    expect(r.finalText).toBe("resumed and done");
    rmSync(dir, { recursive: true, force: true });
  });

  it("soft-continues once when plan is unfinished and reply looks incomplete", async () => {
    const { planUpdateTool } = await import("../src/tools/plan_update.js");
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    const steps = [
      { id: "1", title: "scaffold", status: "completed" as const },
      { id: "2", title: "verify physics", status: "in_progress" as const },
    ];
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "p1", name: "plan_update", input: { steps } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "Next, I will fix the physics loop." },
        { kind: "done", finishReason: "stop" },
      ],
      [
        { kind: "text_delta", messageId: "m3", text: "physics fixed." },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    deps.tools.register(planUpdateTool);
    const r = await runAgent({ history: [], userText: "go" }, deps);
    expect(provider.calls.length).toBe(3);
    const soft = provider.calls[2]!.messages
      .flatMap((m) => m.content)
      .find((c) => c.type === "text" && c.text.includes("unfinished steps"));
    expect(soft).toBeTruthy();
    expect(r.finalText).toBe("physics fixed.");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not soft-continue when the assistant asks the user a question", async () => {
    const { planUpdateTool } = await import("../src/tools/plan_update.js");
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    const steps = [
      { id: "1", title: "scaffold", status: "completed" as const },
      { id: "2", title: "verify", status: "in_progress" as const },
    ];
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "p1", name: "plan_update", input: { steps } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [
        {
          kind: "text_delta",
          messageId: "m2",
          text: "Next, I will verify — should I use headless Chrome or a local browser?",
        },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    deps.tools.register(planUpdateTool);
    const r = await runAgent({ history: [], userText: "go" }, deps);
    expect(provider.calls.length).toBe(2);
    expect(r.finalText).toMatch(/should I use headless/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("helper heuristics match expected soft-stop / wait-for-user cases", () => {
    expect(looksLikeIncompleteTurn("Next, I will patch vehicle.js")).toBe(true);
    expect(looksLikeIncompleteTurn("接下来我会修物理")).toBe(true);
    expect(looksLikeIncompleteTurn("here is the report")).toBe(false);
    expect(isWaitingForUser("Should I proceed?")).toBe(true);
    expect(isWaitingForUser("请确认是否继续")).toBe(true);
    expect(isWaitingForUser("Next, I will patch vehicle.js")).toBe(false);
    expect(
      hasUnfinishedPlan([
        {
          type: "plan",
          steps: [
            { id: "1", title: "a", status: "completed" },
            { id: "2", title: "b", status: "in_progress" },
          ],
        },
      ])
    ).toBe(true);
    expect(
      hasUnfinishedPlan([
        {
          type: "plan",
          steps: [
            { id: "1", title: "a", status: "completed" },
            { id: "2", title: "b", status: "completed" },
          ],
        },
      ])
    ).toBe(false);
  });
});
