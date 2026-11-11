// `auto` and `dont-ask` permission modes: a soft ask is resolved without a
// prompt (classifier adjudicates in `auto`; `dont-ask` denies), while a hard
// floor (dangerous command) still prompts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { z } from "zod";

import { runAgent, type AgentDeps } from "../src/agent.js";
import { PermissionEngine } from "../src/permissions.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { PermissionClassifier } from "../src/permissionClassifier.js";
import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "../src/providers/types.js";

const ran: string[] = [];

/** A provider that calls bash once (first stream), then answers (second). */
class BashThenDone implements ChatProvider {
  readonly name = "scripted";
  defaultModel = "m";
  smallModel = "m";
  calls: StreamChatOptions[] = [];
  constructor(private readonly command: string) {}
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    if (this.calls.length === 1) {
      yield {
        kind: "tool_call",
        messageId: "m1",
        toolCall: { id: "tc1", name: "bash", input: { command: this.command } },
      } as StreamEvent;
      yield { kind: "done", finishReason: "tool_use" };
      return;
    }
    yield { kind: "text_delta", messageId: "m2", text: "done" };
    yield { kind: "done", finishReason: "stop" };
  }
}

function makeDeps(
  cwd: string,
  provider: ChatProvider,
  mode: "auto" | "dont-ask",
  extra: Partial<AgentDeps> = {},
): AgentDeps {
  const tools = new ToolRegistry();
  tools.register({
    name: "bash",
    description: "run a shell command",
    inputSchema: z.object({ command: z.string(), escalate_sandbox: z.boolean().optional() }),
    permission: "execute" as const,
    async execute(input: { command: string }) {
      ran.push(input.command);
      return { content: `ran: ${input.command}` };
    },
  });
  return {
    provider,
    tools,
    artifacts: new ArtifactStore(join(cwd, ".codepilot", "artifacts")),
    permissions: new PermissionEngine({ permissionMode: mode }),
    config: { model: "m", permissionMode: mode } as never,
    cwd,
    ...extra,
  };
}

let cwd: string;
beforeEach(() => {
  ran.length = 0;
  cwd = mkdtempSync(join(tmpdir(), "codepilot-autoperm-"));
  return () => rmSync(cwd, { recursive: true, force: true });
});

describe("auto permission mode", () => {
  it("runs a soft-ask call the classifier allows, without prompting", async () => {
    const classifier: PermissionClassifier = { classify: async () => ({ decision: "allow" }) };
    const onPermissionRequest = vi.fn(async () => "allow" as const);
    const r = await runAgent(
      { history: [], userText: "go" },
      makeDeps(cwd, new BashThenDone("npm test"), "auto", {
        permissionClassifier: classifier,
        onPermissionRequest,
      }),
    );
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(ran).toEqual(["npm test"]);
    expect(r.events.some((e) => e.type === "error")).toBe(false);
  });

  it("refuses a soft-ask call the classifier denies, with the reason, no prompt", async () => {
    const classifier: PermissionClassifier = {
      classify: async () => ({ decision: "deny", reason: "this publishes to a registry" }),
    };
    const onPermissionRequest = vi.fn(async () => "allow" as const);
    const r = await runAgent(
      { history: [], userText: "go" },
      makeDeps(cwd, new BashThenDone("npm publish"), "auto", {
        permissionClassifier: classifier,
        onPermissionRequest,
      }),
    );
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(ran).toEqual([]); // never executed
    const toolResult = r.events.find(
      (e): e is Extract<typeof e, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult?.content).toContain("this publishes to a registry");
  });

  it("still prompts for a hard-floor dangerous command (classifier not consulted)", async () => {
    const classify = vi.fn(async () => ({ decision: "allow" as const }));
    const classifier: PermissionClassifier = { classify };
    const onPermissionRequest = vi.fn(async () => "deny" as const);
    await runAgent(
      { history: [], userText: "go" },
      makeDeps(cwd, new BashThenDone("rm -rf /"), "auto", {
        permissionClassifier: classifier,
        onPermissionRequest,
      }),
    );
    // Hard floor: the human was asked, not the classifier.
    expect(classify).not.toHaveBeenCalled();
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([]);
  });

  it("falls back to a prompt once the classifier's consecutive denial cap is hit", async () => {
    // Deny streak is tracked on the engine; after the cap a soft ask prompts.
    const engine = new PermissionEngine({
      permissionMode: "auto",
      permissionAuto: { maxConsecutiveDenials: 1, maxTotalDenials: 0 },
    });
    // Pre-trip the breaker.
    engine.recordClassifierVerdict(true);
    expect(engine.classifierShouldDefer()).toBe(true);

    const classify = vi.fn(async () => ({ decision: "allow" as const }));
    const onPermissionRequest = vi.fn(async () => "allow" as const);
    await runAgent(
      { history: [], userText: "go" },
      makeDeps(cwd, new BashThenDone("npm test"), "auto", {
        permissions: engine,
        permissionClassifier: { classify },
        onPermissionRequest,
      }),
    );
    expect(classify).not.toHaveBeenCalled(); // deferred to the human
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(["npm test"]);
  });
});

describe("dont-ask permission mode", () => {
  it("denies a soft ask immediately with standard feedback, and continues", async () => {
    const onPermissionRequest = vi.fn(async () => "allow" as const);
    const r = await runAgent(
      { history: [], userText: "go" },
      makeDeps(cwd, new BashThenDone("npm test"), "dont-ask", { onPermissionRequest }),
    );
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
    const toolResult = r.events.find(
      (e): e is Extract<typeof e, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult?.content).toMatch(/dont-ask/i);
    // The run still ends normally (the denial does not abort the prompt).
    expect(r.finalText).toContain("done");
  });

  it("omits feedback when dontAskFeedback is false", async () => {
    const r = await runAgent(
      { history: [], userText: "go" },
      makeDeps(cwd, new BashThenDone("npm test"), "dont-ask", {
        config: { model: "m", permissionMode: "dont-ask", dontAskFeedback: false } as never,
      }),
    );
    const toolResult = r.events.find(
      (e): e is Extract<typeof e, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(toolResult?.content).toBe("permission denied for tool bash");
  });
});
