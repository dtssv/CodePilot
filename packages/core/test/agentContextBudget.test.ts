// Mid-run context management: compact before turns + hard send budget.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runAgent, type AgentDeps } from "../src/agent.js";
import { PermissionEngine } from "../src/permissions.js";
import type { ChatProvider, StreamChatOptions, StreamEvent } from "../src/providers/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { Event } from "../src/types.js";

class ScriptedProvider implements ChatProvider {
  readonly name = "scripted";
  defaultModel = "m";
  smallModel = "m";
  calls: StreamChatOptions[] = [];
  constructor(private readonly script: StreamEvent[][]) {}
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    const step = this.script[this.calls.length - 1] ?? [
      { kind: "text_delta", messageId: "x", text: "done" },
      { kind: "done", finishReason: "stop" },
    ];
    for (const ev of step) yield ev;
  }
}

function makeDeps(
  provider: ChatProvider,
  extra: Partial<AgentDeps> = {},
): { deps: AgentDeps; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-ctx-"));
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
  return {
    dir,
    deps: {
      provider,
      tools,
      artifacts: new ArtifactStore(join(dir, "artifacts")),
      permissions: new PermissionEngine({ permissionMode: "auto-edit" }),
      config: {
        provider: "openai",
        model: "gpt-4o",
        contextWindow: 8_000,
        maxContextTokens: 8_000,
        compactionThreshold: 0.5,
      },
      cwd: dir,
      maxTurns: 4,
      ...extra,
    },
  };
}

describe("runAgent context window enforcement", () => {
  it("calls compactNow when live transcript approaches the configured window", async () => {
    const provider = new ScriptedProvider([
      [
        {
          kind: "tool_call",
          messageId: "m",
          toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "a" } },
        },
        { kind: "done", finishReason: "tool_use" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "ok" },
        { kind: "usage", usage: { input: 5_000, output: 10 } },
        { kind: "done", finishReason: "stop" },
      ],
    ]);
    const pad = (n: number) =>
      Array.from({ length: 80 }, (_, j) => `word${n}_${j}`).join(" ");
    const history: Event[] = [];
    for (let i = 0; i < 40; i++) {
      history.push({
        type: "message",
        id: `u${i}`,
        role: "user",
        content: [{ type: "text", text: pad(i) }],
      });
      history.push({
        type: "message",
        id: `a${i}`,
        role: "assistant",
        content: [{ type: "text", text: pad(i + 100) }],
      });
    }
    const compactNow = vi.fn(async () => {
      return [
        {
          type: "compaction" as const,
          kind: "summary" as const,
          summary: "earlier work summarised",
        },
        history[history.length - 2]!,
        history[history.length - 1]!,
      ];
    });
    const { deps, dir } = makeDeps(provider, { compactNow });
    await runAgent({ history, userText: "continue" }, deps);
    expect(compactNow).toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps provider request bodies under the configured contextWindow", async () => {
    const provider = new ScriptedProvider([
      [
        { kind: "text_delta", messageId: "m", text: "ok" },
        { kind: "done", finishReason: "stop" },
      ],
    ]);
    const history: Event[] = [];
    for (let i = 0; i < 40; i++) {
      history.push({
        type: "message",
        id: `u${i}`,
        role: "user",
        content: [{ type: "text", text: "x".repeat(2_000) }],
      });
      history.push({
        type: "tool_result",
        toolCallId: `t${i}`,
        name: "bash",
        content: "out\n".repeat(500),
      });
    }
    const { deps, dir } = makeDeps(provider, {
      config: {
        provider: "openai",
        model: "gpt-4o",
        contextWindow: 4_000,
        maxTokens: 256,
        maxContextTokens: 50_000, // soft would allow overflow; hard must win
      },
    });
    await runAgent({ history, userText: "go" }, deps);
    expect(provider.calls.length).toBeGreaterThan(0);
    let chars = 0;
    for (const m of provider.calls[0]!.messages) {
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_result") chars += b.content.length;
        else chars += 200;
      }
    }
    // Hard budget ≈ 4000 - 256 - 1024 ≈ 2.7k tokens ≈ ~10k chars; stay well under 4k tokens.
    expect(Math.ceil(chars / 4)).toBeLessThan(4_000);
    rmSync(dir, { recursive: true, force: true });
  });
});
