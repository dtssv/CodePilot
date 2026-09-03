import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/agent.js";
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
});

vi.restoreAllMocks();
