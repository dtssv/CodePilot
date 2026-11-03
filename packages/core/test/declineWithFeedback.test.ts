// Decline-with-feedback: when the permission handler denies a tool call but
// returns a correction message, the model must see that message as the tool
// result (so a denial becomes steering) instead of a canned "permission
// denied". A bare-string deny still produces the canned message.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import { z } from "zod";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import type { ChatProvider, StreamChatOptions, StreamEvent } from "../src/providers/types.js";
import type { AgentDeps } from "../src/agent.js";
import type { Event, PermissionResolution } from "../src/types.js";

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
      yield { kind: "text_delta", messageId: "m", text: "(done)" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    for (const ev of this.responses[i]!) yield ev;
  }
}

function makeWriteTool() {
  return {
    name: "patch",
    description: "mock write tool",
    inputSchema: z.object({ path: z.string() }),
    permission: "write" as const,
    async execute() {
      return { content: "patched!" };
    },
  };
}

function toolResultContents(events: Event[], name: string): string[] {
  return events
    .filter((e): e is Extract<Event, { type: "tool_result" }> => e.type === "tool_result" && e.name === name)
    .map((e) => e.content);
}

function makeDeps(
  cwd: string,
  provider: MockProvider,
  onPermissionRequest: (req: { toolName: string }) => Promise<PermissionResolution>,
): AgentDeps {
  const tools = new ToolRegistry();
  tools.register(makeWriteTool());
  const artifacts = new ArtifactStore(join(cwd, ".codepilot", "artifacts"));
  return {
    provider,
    tools,
    artifacts,
    permissions: new PermissionEngine({ permissionMode: "ask" }),
    config: { provider: "anthropic" },
    cwd,
    maxTurns: 5,
    onPermissionRequest: onPermissionRequest as AgentDeps["onPermissionRequest"],
  };
}

describe("decline-with-feedback", () => {
  it("surfaces the correction message to the model as the tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decline-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "patch", input: { path: "a.txt" } },
        },
        { kind: "done", finishReason: "stop" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "ok, editing b.txt instead" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const deps = makeDeps(dir, provider, async () => ({
      decision: "deny",
      feedback: "Don't touch a.txt — edit b.txt instead.",
    }));
    const r = await runAgent({ history: [], userText: "patch a.txt" }, deps);

    const results = toolResultContents(r.events, "patch");
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("Don't touch a.txt — edit b.txt instead.");
    expect(results[0]).not.toBe("permission denied for tool patch");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the canned message for a bare-string deny", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decline-bare-"));
    const provider = new MockProvider();
    provider.responses = [
      [
        {
          kind: "tool_call",
          messageId: "m1",
          toolCall: { type: "tool_use", id: "t1", name: "patch", input: { path: "a.txt" } },
        },
        { kind: "done", finishReason: "stop" },
      ],
      [
        { kind: "text_delta", messageId: "m2", text: "understood" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const deps = makeDeps(dir, provider, async () => "deny");
    const r = await runAgent({ history: [], userText: "patch a.txt" }, deps);

    const results = toolResultContents(r.events, "patch");
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("permission denied for tool patch");
    rmSync(dir, { recursive: true, force: true });
  });
});
