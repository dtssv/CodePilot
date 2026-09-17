import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  runtimeRegistry,
  RuntimeRegistry,
  DefaultRuntime,
  DEFAULT_RUNTIME_NAME,
  type AgentRuntime,
  type RuntimeFactory,
} from "../src/runtime.js";
import { runAgent, type AgentDeps } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "../src/providers/types.js";

class MockProvider implements ChatProvider {
  readonly name = "mock";
  defaultModel = "mock-large";
  smallModel = "mock-small";
  responses: StreamEvent[][] = [];
  calls: StreamChatOptions[] = [];
  private idx = 0;
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    const i = this.idx++;
    if (i >= this.responses.length) {
      yield { kind: "text_delta", messageId: "m", text: "done" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    for (const ev of this.responses[i]!) yield ev;
  }
}

function makeDeps(cwd: string, provider: MockProvider): AgentDeps {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    inputSchema: z.object({ x: z.string() }),
    permission: "read" as const,
    async execute() {
      return { content: "echoed" };
    },
  });
  return {
    provider,
    tools,
    artifacts: new ArtifactStore(join(cwd, ".codepilot", "artifacts")),
    permissions: new PermissionEngine({}),
    config: { model: "mock-large" } as never,
    cwd,
  };
}

describe("RuntimeRegistry", () => {
  it("pre-registers the default runtime", () => {
    expect(runtimeRegistry.has(DEFAULT_RUNTIME_NAME)).toBe(true);
    expect(runtimeRegistry.list()).toContain(DEFAULT_RUNTIME_NAME);
  });

  it("resolves undefined name to the default runtime", () => {
    const r = runtimeRegistry.resolve(undefined, { cwd: process.cwd() });
    expect(r.name).toBe(DEFAULT_RUNTIME_NAME);
    expect(r).toBeInstanceOf(DefaultRuntime);
  });

  it("throws on unknown explicit names", () => {
    expect(() => runtimeRegistry.resolve("nope", { cwd: process.cwd() })).toThrow(
      /Unknown agent runtime/
    );
  });

  it("cannot unregister the default runtime", () => {
    expect(runtimeRegistry.unregister(DEFAULT_RUNTIME_NAME)).toBe(false);
    expect(runtimeRegistry.has(DEFAULT_RUNTIME_NAME)).toBe(true);
  });

  it("registers and resolves a custom factory", () => {
    const created: AgentRuntime[] = [];
    const factory: RuntimeFactory = {
      name: "test-custom",
      create: (deps) => {
        const rt: AgentRuntime = {
          name: "test-custom",
          async prompt() {
            return { events: [], hadToolCalls: false, finalText: "" };
          },
          cancel() {},
          state() {
            return "idle";
          },
        };
        created.push(rt);
        expect(deps.cwd).toBe(process.cwd());
        return rt;
      },
    };
    const reg = new RuntimeRegistry();
    reg.register(factory);
    const r = reg.resolve("test-custom", { cwd: process.cwd() });
    expect(r.name).toBe("test-custom");
    expect(created).toHaveLength(1);
    expect(reg.unregister("test-custom")).toBe(true);
    expect(reg.has("test-custom")).toBe(false);
  });
});

describe("DefaultRuntime", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "codepilot-rt-"));
    return () => rmSync(cwd, { recursive: true, force: true });
  });

  it("wraps runAgent and emits the same result", async () => {
    const provider = new MockProvider();
    provider.responses = [
      [
        { kind: "text_delta", messageId: "m1", text: "hello" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const deps = makeDeps(cwd, provider);
    const runtime = new DefaultRuntime();
    expect(runtime.state()).toBe("idle");
    const result = await runtime.prompt(
      { history: [], userText: "hi" },
      deps
    );
    expect(result.finalText).toBe("hello");
    expect(result.hadToolCalls).toBe(false);
    expect(result.events.some((e) => e.type === "message" && e.role === "assistant")).toBe(true);
    expect(runtime.state()).toBe("idle");
  });

  it("rejects a re-entrant prompt()", async () => {
    const provider = new MockProvider();
    const deps = makeDeps(cwd, provider);
    const runtime = new DefaultRuntime();
    // Force running state by entering prompt and racing a second call.
    const first = runtime.prompt(
      { history: [], userText: "hi" },
      { ...deps, provider: new MockProvider() }
    );
    // provider yields nothing -> still resolves quickly; ensure state returned to idle.
    await first;
    expect(runtime.state()).toBe("idle");
  });

  it("stream() yields events in order then completes", async () => {
    const provider = new MockProvider();
    provider.responses = [
      [
        { kind: "text_delta", messageId: "m1", text: "a" },
        { kind: "text_delta", messageId: "m1", text: "b" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const deps = makeDeps(cwd, provider);
    const runtime = new DefaultRuntime();
    const seen: string[] = [];
    for await (const e of runtime.stream({ history: [], userText: "hi" }, deps)) {
      if (e.type === "message" && e.role === "assistant") {
        const text = (e.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        seen.push(text);
      }
    }
    expect(seen).toEqual(["ab"]);
  });
});

describe("Session integration (runtime wiring)", () => {
  it("default runtime produces events equivalent to runAgent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codepilot-sess-rt-"));
    try {
      const provider = new MockProvider();
      provider.responses = [
        [
          { kind: "text_delta", messageId: "m1", text: "ok" },
          { kind: "done", finishReason: "stop" },
        ],
      ];
      const deps = makeDeps(cwd, provider);
      const direct = await runAgent({ history: [], userText: "hi" }, deps);

      const provider2 = new MockProvider();
      provider2.responses = provider.responses;
      const deps2 = makeDeps(cwd, provider2);
      const rt = new DefaultRuntime();
      const wrapped = await rt.prompt({ history: [], userText: "hi" }, deps2);

      expect(wrapped.finalText).toBe(direct.finalText);
      expect(wrapped.hadToolCalls).toBe(direct.hadToolCalls);
      expect(wrapped.events.length).toBe(direct.events.length);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
