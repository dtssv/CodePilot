// Soft steering: a user correction that arrives while the model is streaming
// waits for the current stream (+ any tool batch) to finish, then lands as a
// user message at the next turn boundary — never aborting mid-stream or
// marking remaining tools as interrupted.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { runAgent } from "../src/agent/agent.js";
import type { AgentDeps } from "../src/agent/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions/permissions.js";
import type { ChatProvider, StreamChatOptions, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

/**
 * First stream emits text, queues a steer mid-stream via `onFirstDelta`, then
 * finishes the turn. Second stream answers after the steer is drained.
 */
class SoftSteerProvider implements ChatProvider {
  readonly name = "mock";
  defaultModel = "mock-large";
  smallModel = "mock-small";
  calls: StreamChatOptions[] = [];
  private idx = 0;
  constructor(private readonly onFirstDelta: () => void) {}
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    const i = this.idx++;
    if (i === 0) {
      yield { kind: "text_delta", messageId: "m", text: "starting the wrong approach" };
      this.onFirstDelta();
      await new Promise((r) => setTimeout(r, 5));
      yield { kind: "text_delta", messageId: "m", text: " (stream still finishes)" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    yield { kind: "text_delta", messageId: "m", text: "redone the right way" };
    yield { kind: "done", finishReason: "stop" };
  }
}

function deps(cwd: string, provider: ChatProvider, extra: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider,
    tools: new ToolRegistry(),
    artifacts: new ArtifactStore(join(cwd, ".codepilot", "artifacts")),
    permissions: new PermissionEngine({ permissionMode: "auto-edit" }),
    config: { provider: "anthropic" },
    cwd,
    maxTurns: 5,
    systemPrompt: { staticPrefix: "SYS", dynamicSuffix: "" },
    ...extra,
  };
}

describe("runAgent soft steering (wait for current step)", () => {
  it("lets the stream finish, then re-samples with the correction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "softsteer-"));
    const emitted: Event[] = [];

    let pendingSteer: string | null = null;
    const raiseSteer = (text: string): void => {
      pendingSteer = text;
      // Soft steer: queue only — do not abort the stream.
    };

    const provider = new SoftSteerProvider(() => raiseSteer("use the right approach instead"));

    await runAgent(
      { history: [], userText: "go" },
      {
        ...deps(dir, provider),
        onEvent: (e) => void emitted.push(e),
        peekSteering: () => pendingSteer !== null,
        drainSteering: () => {
          if (pendingSteer === null) return [];
          const out = [{ source: "user" as const, text: pendingSteer }];
          pendingSteer = null;
          return out;
        },
      },
    );

    const userSteer = emitted.filter(
      (e) =>
        e.type === "message" &&
        e.role === "user" &&
        e.content.some((c) => c.type === "text" && c.text.includes("use the right approach")),
    );
    expect(userSteer).toHaveLength(1);

    const assistantTexts = emitted
      .filter((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "assistant")
      .flatMap((e) => e.content)
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    expect(assistantTexts.some((t) => t.includes("starting the wrong approach"))).toBe(true);
    // Soft steer does not cut the stream mid-turn.
    expect(assistantTexts.some((t) => t.includes("stream still finishes"))).toBe(true);
    expect(assistantTexts.some((t) => t.includes("redone the right way"))).toBe(true);

    const errorEvents = emitted.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not skip remaining tools when a steer arrives mid-batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "softsteer-tools-"));
    const emitted: Event[] = [];
    let pendingSteer: string | null = null;
    let firstToolStarted = false;

    class TwoToolsProvider implements ChatProvider {
      readonly name = "mock";
      defaultModel = "mock-large";
      smallModel = "mock-small";
      private idx = 0;
      async *stream(): AsyncIterable<StreamEvent> {
        const i = this.idx++;
        if (i === 0) {
          yield { kind: "tool_call", toolCall: { id: "t1", name: "noop", input: { n: 1 } } };
          yield { kind: "tool_call", toolCall: { id: "t2", name: "noop", input: { n: 2 } } };
          yield { kind: "done", finishReason: "tool_calls" };
          return;
        }
        yield { kind: "text_delta", messageId: "m", text: "done after both tools + steer" };
        yield { kind: "done", finishReason: "stop" };
      }
    }

    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "noop",
      inputSchema: z.object({ n: z.number() }),
      // Exclusive (execute) so tools serialize — a mid-batch steer used to skip
      // the second call; soft steer must still run it.
      permission: "execute",
      async execute(input: { n: number }) {
        if (!firstToolStarted) {
          firstToolStarted = true;
          pendingSteer = "nudge mid tools";
        }
        return { content: `noop ${input.n}` };
      },
    } as never);

    await runAgent(
      { history: [], userText: "go" },
      {
        ...deps(dir, new TwoToolsProvider(), {
          tools: registry,
          permissions: new PermissionEngine({ permissionMode: "yolo" }),
        }),
        onEvent: (e) => void emitted.push(e),
        peekSteering: () => pendingSteer !== null,
        drainSteering: () => {
          if (pendingSteer === null) return [];
          const out = [{ source: "user" as const, text: pendingSteer }];
          pendingSteer = null;
          return out;
        },
      },
    );

    const toolResults = emitted.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    for (const r of toolResults) {
      expect(r.type === "tool_result" && r.isError).toBeFalsy();
      expect(r.type === "tool_result" && r.content).not.toMatch(/interrupted/);
    }
    const userSteer = emitted.filter(
      (e) =>
        e.type === "message" &&
        e.role === "user" &&
        e.content.some((c) => c.type === "text" && c.text.includes("nudge mid tools")),
    );
    expect(userSteer).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });
});
