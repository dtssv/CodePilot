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
  responses: StreamEvent[][] = [];
  private idx = 0;
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const i = this.idx++;
    const plan = this.responses[i];
    if (!plan) {
      yield { kind: "text_delta", messageId: "m", text: "(no more)" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    for (const ev of plan) yield ev;
  }
}

function makeDeps(cwd: string, provider: MockProvider) {
  const tools = new ToolRegistry();
  const echo = {
    name: "echo",
    description: "echo",
    inputSchema: z.object({ x: z.string() }),
    permission: "read" as const,
    async execute() { return { content: "ok" }; },
  };
  tools.register(echo);
  return {
    artifacts: new ArtifactStore(join(cwd, ".codepilot", "artifacts")),
    permissions: new PermissionEngine({ permissionMode: "yolo" }),
    deps(extra: Partial<AgentDeps>): AgentDeps {
      return {
        provider,
        tools,
        artifacts: this.artifacts,
        permissions: this.permissions,
        config: { provider: "anthropic", model: "mock-large" },
        cwd,
        maxTurns: 5,
        ...extra,
      };
    },
  };
}

describe("runAgent — onTokenEstimate hook", () => {
  it("fires after each turn with a token estimate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tok-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        { kind: "text_delta", messageId: "m1", text: "thinking out loud here" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const estimates: Array<{ tokens: number; turns: number; window: number }> = [];
    await runAgent(
      { history: [], userText: "hello world this is a test" },
      f.deps({ onTokenEstimate: (e) => estimates.push(e) })
    );
    expect(estimates.length).toBeGreaterThan(0);
    const last = estimates[estimates.length - 1]!;
    expect(last.tokens).toBeGreaterThan(0);
    expect(last.turns).toBeGreaterThanOrEqual(1);
    expect(last.window).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not throw if the listener errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tok-"));
    const provider = new MockProvider();
    provider.responses = [
      [{ kind: "text_delta", messageId: "m1", text: "hi" }, { kind: "done", finishReason: "stop" }],
    ];
    const f = makeDeps(dir, provider);
    await runAgent(
      { history: [], userText: "x" },
      f.deps({ onTokenEstimate: () => { throw new Error("boom"); } })
    );
    // The agent should still complete normally.
    rmSync(dir, { recursive: true, force: true });
  });
});
