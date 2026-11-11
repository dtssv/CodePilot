// Mid-stream steering (B1): a user correction that arrives while the model is
// still emitting a turn cuts the provider stream at a safe boundary (before any
// tool call), keeps the partial text, and re-samples with the correction as a
// user message — all within the same prompt, without marking the run cancelled.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import type { AgentDeps } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import type { ChatProvider, StreamChatOptions, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

/**
 * On the first stream the provider emits one text delta, then waits for the
 * host to raise a steer (signalled via `onFirstDelta`). Once the steer signal
 * aborts it stops yielding — exactly how a real provider reacts to an aborted
 * fetch. Subsequent streams answer normally.
 */
class SteerableProvider implements ChatProvider {
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
      // The host now raises a steer; the agent aborts this stream at the next
      // boundary. Give the microtask queue a chance to propagate the abort.
      this.onFirstDelta();
      for (let n = 0; n < 50 && !opts.signal?.aborted; n++) {
        await new Promise((r) => setTimeout(r, 1));
      }
      if (opts.signal?.aborted) return;
      yield { kind: "text_delta", messageId: "m", text: " (should not be reached)" };
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

describe("runAgent mid-stream steering (B1)", () => {
  it("cuts the stream on a pending user steer, keeps partial text, re-samples with the correction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "midsteer-"));
    const emitted: Event[] = [];

    // Minimal host-side queue + steer controller, mirroring the Session wiring.
    let pendingSteer: string | null = null;
    let steerController = new AbortController();
    const raiseSteer = (text: string): void => {
      pendingSteer = text;
      steerController.abort();
    };

    const provider = new SteerableProvider(() => raiseSteer("use the right approach instead"));

    await runAgent(
      { history: [], userText: "go" },
      {
        ...deps(dir, provider),
        onEvent: (e) => void emitted.push(e),
        peekSteering: () => pendingSteer !== null,
        getSteerSignal: () => steerController.signal,
        drainSteering: () => {
          // Rotate the controller so the next stream starts un-aborted.
          if (steerController.signal.aborted) steerController = new AbortController();
          if (pendingSteer === null) return [];
          const out = [{ source: "user" as const, text: pendingSteer }];
          pendingSteer = null;
          return out;
        },
      },
    );

    // The steer became a real user message in the transcript.
    const userSteer = emitted.filter(
      (e) => e.type === "message" && e.role === "user" &&
        e.content.some((c) => c.type === "text" && c.text.includes("use the right approach")),
    );
    expect(userSteer).toHaveLength(1);

    // The partial text from the cut stream was kept as an assistant message.
    const assistantTexts = emitted
      .filter((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "assistant")
      .flatMap((e) => e.content)
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    expect(assistantTexts.some((t) => t.includes("starting the wrong approach"))).toBe(true);
    // The post-steer boundary text was never produced (stream was cut).
    expect(assistantTexts.some((t) => t.includes("should not be reached"))).toBe(false);
    // The re-sampled answer is present.
    expect(assistantTexts.some((t) => t.includes("redone the right way"))).toBe(true);

    // The run did NOT end as cancelled: there is no abort/cancel error event.
    const errorEvents = emitted.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    // The provider was called at least twice (initial + re-sample).
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not preempt once a tool call has started; the steer waits for the next boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "midsteer-tool-"));
    const emitted: Event[] = [];
    let pendingSteer: string | null = "late correction";
    let steerController = new AbortController();
    // Steer is already pending AND aborted before the stream starts — but the
    // first stream emits a tool_call, so the peek guard must NOT preempt it.
    steerController.abort();

    class ToolFirstProvider implements ChatProvider {
      readonly name = "mock";
      defaultModel = "mock-large";
      smallModel = "mock-small";
      private idx = 0;
      async *stream(): AsyncIterable<StreamEvent> {
        const i = this.idx++;
        if (i === 0) {
          yield { kind: "tool_call", toolCall: { id: "t1", name: "noop", input: {} } };
          yield { kind: "done", finishReason: "tool_calls" };
          return;
        }
        yield { kind: "text_delta", messageId: "m", text: "done after tool" };
        yield { kind: "done", finishReason: "stop" };
      }
    }

    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "noop",
      inputSchema: z.object({}),
      permission: "read",
      async execute() {
        return { content: "noop ok" };
      },
    } as never);

    await runAgent(
      { history: [], userText: "go" },
      {
        ...deps(dir, new ToolFirstProvider(), { tools: registry }),
        onEvent: (e) => void emitted.push(e),
        peekSteering: () => pendingSteer !== null,
        getSteerSignal: () => steerController.signal,
        drainSteering: () => {
          if (steerController.signal.aborted) steerController = new AbortController();
          if (pendingSteer === null) return [];
          const out = [{ source: "user" as const, text: pendingSteer }];
          pendingSteer = null;
          return out;
        },
      },
    );

    // The tool call executed (not preempted).
    const toolResults = emitted.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    // The steer still landed as a user message at the post-tool boundary.
    const userSteer = emitted.filter(
      (e) => e.type === "message" && e.role === "user" &&
        e.content.some((c) => c.type === "text" && c.text.includes("late correction")),
    );
    expect(userSteer).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });
});
