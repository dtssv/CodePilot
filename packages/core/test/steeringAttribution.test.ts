// Steering attribution: user-sourced steering becomes a real user message;
// engine-generated (system) notices never do — they ride in the per-turn
// runtime_context so they cannot impersonate human input (the background-job
// completion notice was the motivating case).

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { buildLiveContext, runAgent } from "../src/agent.js";
import type { AgentDeps } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import type { ChatProvider, StreamChatOptions, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

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
    const plan = this.responses[i] ?? [
      { kind: "text_delta", messageId: "m", text: "ok" },
      { kind: "done", finishReason: "stop" },
    ];
    for (const ev of plan) yield ev;
  }
}

function deps(cwd: string, provider: MockProvider, extra: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider,
    tools: new ToolRegistry(),
    artifacts: new ArtifactStore(join(cwd, ".codepilot", "artifacts")),
    permissions: new PermissionEngine({ permissionMode: "auto-edit" }),
    config: { provider: "anthropic" },
    cwd,
    maxTurns: 5,
    // liveContext only reaches the provider when a systemPrompt exists (real
    // sessions always have one). A minimal prefix is enough here.
    systemPrompt: { staticPrefix: "SYS", dynamicSuffix: "" },
    ...extra,
  };
}

describe("buildLiveContext system notices", () => {
  it("wraps each system notice in a <system_notice> block", () => {
    const out = buildLiveContext([], [], { systemNotices: ["job X exited"] });
    expect(out).toContain("<system_notice>");
    expect(out).toContain("job X exited");
    expect(out).toContain("</system_notice>");
  });

  it("adds nothing when there are no notices", () => {
    expect(buildLiveContext([], [], {})).not.toContain("system_notice");
  });
});

describe("runAgent steering attribution", () => {
  it("injects user-sourced steering as a real user message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steer-"));
    const provider = new MockProvider();
    const emitted: Event[] = [];
    await runAgent(
      { history: [], userText: "go" },
      {
        ...deps(dir, provider),
        onEvent: (e) => void emitted.push(e),
        drainSteering: () => [{ source: "user", text: "also handle the edge case" }],
      },
    );
    const userMsgs = emitted.filter(
      (e) => e.type === "message" && e.role === "user" &&
        e.content.some((c) => c.type === "text" && c.text.includes("edge case")),
    );
    expect(userMsgs).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT inject a system notice as a user message; it rides in runtime_context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steer-"));
    const provider = new MockProvider();
    const emitted: Event[] = [];
    const notice = 'Background job job_abc (sleep 1) exited with code 0. Use bash_output({ job_id: "job_abc" }) to read its output.';
    await runAgent(
      { history: [], userText: "go" },
      {
        ...deps(dir, provider),
        onEvent: (e) => void emitted.push(e),
        drainSteering: () => [{ source: "system", text: notice }],
      },
    );

    // 1. It must NOT appear as any user message in the transcript.
    const asUserMessage = emitted.some(
      (e) => e.type === "message" && e.role === "user" &&
        e.content.some((c) => c.type === "text" && c.text.includes("Background job job_abc")),
    );
    expect(asUserMessage).toBe(false);

    // 2. It must reach the provider inside a <system_notice> block (via the
    //    runtime_context), so the model still learns the job finished.
    const sentText = provider.calls
      .flatMap((call) => call.messages)
      .flatMap((m) => m.content)
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(sentText).toContain("<system_notice>");
    expect(sentText).toContain("Background job job_abc");
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes a mix: user steering to the transcript, system notices to context only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steer-"));
    const provider = new MockProvider();
    const emitted: Event[] = [];
    await runAgent(
      { history: [], userText: "go" },
      {
        ...deps(dir, provider),
        onEvent: (e) => void emitted.push(e),
        drainSteering: () => [
          { source: "system", text: "job done notice" },
          { source: "user", text: "user follow-up" },
        ],
      },
    );
    const userTexts = emitted
      .filter((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user")
      .flatMap((e) => e.content)
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    expect(userTexts.some((t) => t.includes("user follow-up"))).toBe(true);
    expect(userTexts.some((t) => t.includes("job done notice"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
