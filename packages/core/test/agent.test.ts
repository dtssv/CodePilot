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

  /** When true, a request with toolChoice:"none" yields text instead of the
   * queued tool call — simulating a provider that honors the tool lockout (real
   * providers stop emitting tool calls under toolChoice:"none"). */
  honorToolChoiceNone = false;

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    if (this.honorToolChoiceNone && opts.toolChoice === "none") {
      yield { kind: "text_delta", messageId: `locked_${this.idx}`, text: "stopping — here is what I have" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
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
  // A write-permission tool so tests can simulate durable progress (resets the
  // no-progress stall streak), mirroring write_file/edit_file.
  tools.register(makeTool("write_file", "write", "wrote!"));
  // A read tool in EXPLORATION_READ_TOOLS that echoes a distinct body per call
  // (the input `x`), so a varied call is a dedup-cache MISS and reads as NEW
  // evidence — exercising the exploration-stall track rather than the write one.
  tools.register({
    name: "read_file",
    description: "mock read_file",
    inputSchema: z.object({ x: z.string() }),
    permission: "read" as const,
    async execute(input: { x: string }) {
      return { content: `file body for ${input.x}` };
    },
  });
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

describe("runAgent maxTurns (unset = unlimited, with convergence backstop)", () => {
  it("does not cap turns when maxTurns is unset and well under the convergence cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // 8 tool turns then a final text reply — unset maxTurns allows many loops,
    // and 9 turns is far below the default convergence cap (60), so the
    // convergence backstop does not engage here.
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
    expect(r.events.some((e) => e.type === "error" && /maxTurns|convergence/i.test(e.message))).toBe(false);
    // No turn should have tools disabled — we never reached wind-down.
    expect(provider.calls.every((c) => c.toolChoice === undefined)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("winds down via the convergence cap even when maxTurns is unlimited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // A weak-model stand-in that NEVER stops calling tools (slightly different
    // input each turn, so the exact-signature DoomLoopDetector can't catch it).
    provider.responses = [];
    for (let i = 0; i < 40; i++) {
      provider.responses.push([
        {
          kind: "tool_call",
          messageId: `m${i}`,
          toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } },
        },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    // maxTurns unlimited; small convergence cap so the test is fast.
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 4;
    const r = await runAgent({ history: [], userText: "spin forever" }, deps);
    // Wind-down starts at turn 3 (windDownAt 4, remaining <= 1), where tools are
    // disabled; the hard break is CONVERGENCE_HARD_SLACK (3) turns above that.
    // The run must stop well short of the 40 queued responses.
    expect(provider.calls.length).toBeLessThanOrEqual(8);
    // At least one turn before the end must have sent toolChoice:"none".
    expect(provider.calls.some((c) => c.toolChoice === "none")).toBe(true);
    // Because this model ignored the lock and kept calling tools, the run hits
    // the convergence backstop and surfaces a recoverable error naming it.
    const err = r.events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.recoverable).toBe(true);
    expect(err && err.type === "error" && err.message).toMatch(/convergence limit \(4 turns\)/);
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets a stuck model land softly on text at the convergence cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // Model keeps calling tools until wind-down disables them, then answers.
    provider.responses = [];
    for (let i = 0; i < 3; i++) {
      provider.responses.push([
        {
          kind: "tool_call",
          messageId: `m${i}`,
          toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } },
        },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    // At the wind-down turn (tools disabled) it produces text and stops.
    provider.responses.push([
      { kind: "text_delta", messageId: "fin", text: "answered from what I have" },
      { kind: "done", finishReason: "stop" },
    ]);
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 4;
    const r = await runAgent({ history: [], userText: "verify forever" }, deps);
    // Clean landing: an answer, no error, idle.
    expect(r.finalText).toBe("answered from what I have");
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("disables the convergence backstop when convergenceCap is 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // 70 WRITE turns (above the default cap of 60) then text — each write is
    // durable progress, so the no-progress ladder never fires; with the absolute
    // backstop disabled none of these should be capped.
    provider.responses = [];
    for (let i = 0; i < 70; i++) {
      provider.responses.push([
        {
          kind: "tool_call",
          messageId: `m${i}`,
          toolCall: { type: "tool_use", id: `t${i}`, name: "write_file", input: { x: String(i) } },
        },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    provider.responses.push([
      { kind: "text_delta", messageId: "done", text: "finished long task" },
      { kind: "done", finishReason: "stop" },
    ]);
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 0;
    const r = await runAgent({ history: [], userText: "genuinely long task" }, deps);
    expect(provider.calls.length).toBe(71);
    expect(r.finalText).toBe("finished long task");
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(provider.calls.every((c) => c.toolChoice === undefined)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("locks tools after NO_PROGRESS_LOCK_TURNS of read-only spinning (soft land)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // A provider that honors toolChoice:"none" by answering — like a real one
    // that stops emitting tool calls when the lock is set.
    provider.honorToolChoiceNone = true;
    // Model keeps calling a read-only tool with a different input each turn —
    // textually distinct (so the doom loop can't catch it), no durable progress.
    // After 16 such turns the stall ladder must lock tools; the model then
    // answers from what it has. convergenceCap raised high so the ABSOLUTE cap
    // is not what stops it — this isolates the progress-gated path.
    provider.responses = [];
    for (let i = 0; i < 30; i++) {
      provider.responses.push([
        {
          kind: "tool_call",
          messageId: `m${i}`,
          toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: `v${i}` } },
        },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 500; // keep the absolute cap out of the way
    const r = await runAgent({ history: [], userText: "verify in circles" }, deps);
    // Streak increments at each turn's end; the start-of-turn lock fires once it
    // reaches 16, so the lock turn is call index 16 → 17 calls total.
    expect(provider.calls.length).toBe(17);
    // The locking turn (and only it) sent toolChoice:"none".
    expect(provider.calls.filter((c) => c.toolChoice === "none").length).toBe(1);
    expect(provider.calls[16]!.toolChoice).toBe("none");
    // Soft land: the model answered, no error.
    expect(r.finalText).toBe("stopping — here is what I have");
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not throttle a long task that keeps making durable progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // 24 turns that alternate: a few read-only probes, then a write. Because a
    // write resets the no-progress streak before it reaches 16, tools are never
    // locked and the run proceeds normally to its own text ending.
    provider.responses = [];
    for (let i = 0; i < 24; i++) {
      const isWrite = i % 4 === 3; // write every 4th turn → streak never hits 16
      provider.responses.push([
        {
          kind: "tool_call",
          messageId: `m${i}`,
          toolCall: {
            type: "tool_use",
            id: `t${i}`,
            name: isWrite ? "write_file" : "echo",
            input: { x: `v${i}` },
          },
        },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    provider.responses.push([
      { kind: "text_delta", messageId: "done", text: "task complete" },
      { kind: "done", finishReason: "stop" },
    ]);
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 500;
    const r = await runAgent({ history: [], userText: "long implementation task" }, deps);
    // Ran all 24 tool turns + the final text (no lock, no early stop).
    expect(provider.calls.length).toBe(25);
    expect(r.finalText).toBe("task complete");
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    // Tools were never disabled — durable progress kept resetting the streak.
    expect(provider.calls.every((c) => c.toolChoice === undefined)).toBe(true);
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
    // Hard tool-lockout at the budget boundary: the LAST turn (turn 1, the
    // final one before the cap) must send `toolChoice:"none"` so the model
    // physically cannot start another tool call; the first turn must not.
    expect(provider.calls[0]!.toolChoice).toBeUndefined();
    expect(provider.calls[1]!.toolChoice).toBe("none");
    rmSync(dir, { recursive: true, force: true });
  });

  it("soft-lands a sub-agent at its step budget (synthesis urge, no hard error)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // 2 configured turns of tools, then the bonus synthesis turn returns text.
    provider.responses = [
      [
        { kind: "tool_call", messageId: "m1", toolCall: { type: "tool_use", id: "t1", name: "echo", input: { x: "1" } } },
        { kind: "done", finishReason: "stop" },
      ],
      [
        { kind: "tool_call", messageId: "m2", toolCall: { type: "tool_use", id: "t2", name: "echo", input: { x: "2" } } },
        { kind: "done", finishReason: "stop" },
      ],
      [
        { kind: "text_delta", messageId: "m3", text: "### Findings\n- done\n\n### Key references\n- none\n\n### Recommendations\n- none" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const deps = { ...f.deps(), maxTurns: 2, isSubagent: true };
    const r = await runAgent({ history: [], userText: "go" }, deps);
    // Soft landing: no error event, idle, and a synthesized conclusion.
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    expect(r.finalText).toMatch(/Findings/);
    expect(r.reachedTurnBudget).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // Graceful wind-down (agent.ts:444-461): the budget is not a hard wall — the
  // last turns inject a runtime_context nudge urging synthesis, so the model
  // lands softly instead of being cut off mid-tool-call. These pin the gradient
  // + its carrier.
  function systemText(opts: StreamChatOptions): string {
    return opts.messages
      .filter((m) => m.role === "system")
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
  }

  it("injects a graded wind-down nudge on the last two turns (main session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // maxTurns 4 → turns 0..3. Keep calling tools so we reach the wind-down.
    provider.responses = [];
    for (let i = 0; i < 4; i++) {
      provider.responses.push([
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = {
      ...f.deps(),
      maxTurns: 4,
      // A minimal system prompt so liveContext (which carries the nudge) is
      // actually injected as a system message we can inspect.
      systemPrompt: { staticPrefix: "SYS", volatileSuffix: "<plan></plan>" },
    };
    await runAgent({ history: [], userText: "go" }, deps);
    // turn 2 (remaining == 2): soft tier-stable "few turns left" nudge (no
    // per-turn counter — keeps the trailing runtime_context cacheable).
    expect(systemText(provider.calls[2]!)).toMatch(/few turns left in your budget/i);
    // turn 3 (remaining == 1): hard "do NOT call any more tools, write your
    // final answer now" nudge.
    const last = systemText(provider.calls[3]!);
    expect(last).toMatch(/reached the turn budget for this task/);
    expect(last).toMatch(/[Dd]o NOT call any more|final answer now/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives a sub-agent a structured synthesis nudge (Findings/References/...)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [];
    for (let i = 0; i < 3; i++) {
      provider.responses.push([
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = {
      ...f.deps(),
      maxTurns: 2,
      isSubagent: true,
      systemPrompt: { staticPrefix: "SYS", volatileSuffix: "<plan></plan>" },
    };
    await runAgent({ history: [], userText: "go" }, deps);
    // The sub-agent variant asks for a structured conclusion, not just "write
    // your answer" — so the parent's outcome assessment has sections to read.
    const nudges = provider.calls.map(systemText).join("\n---\n");
    expect(nudges).toMatch(/Findings/);
    expect(nudges).toMatch(/Recommendations|Blocker/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("drives the wind-down from config.convergence.cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [];
    for (let i = 0; i < 40; i++) {
      provider.responses.push([
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    // No flat convergenceCap; the nested block governs instead.
    deps.config.convergence = { cap: 4 };
    const r = await runAgent({ history: [], userText: "spin" }, deps);
    expect(provider.calls.length).toBeLessThanOrEqual(8);
    expect(provider.calls.some((c) => c.toolChoice === "none")).toBe(true);
    const err = r.events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.message).toMatch(/convergence limit \(4 turns\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never locks tools on convergence when config.convergence.cap is 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // 70 WRITE turns (above the default cap of 60) then text — each write is
    // durable progress, so the no-progress ladder never fires; with the cap
    // disabled none of these should be capped.
    provider.responses = [];
    for (let i = 0; i < 70; i++) {
      provider.responses.push([
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "write_file", input: { x: String(i) } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    provider.responses.push([
      { kind: "text_delta", messageId: "fin", text: "done" },
      { kind: "done", finishReason: "stop" },
    ]);
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.config.convergence = { cap: 0 };
    const r = await runAgent({ history: [], userText: "long write task" }, deps);
    expect(r.finalText).toBe("done");
    expect(provider.calls.every((c) => c.toolChoice === undefined)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a per-turn turn_budget snapshot with the governing ceiling and warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // maxTurns 4 → turns 0..3; keep calling tools so we reach the wind-down.
    provider.responses = [];
    for (let i = 0; i < 4; i++) {
      provider.responses.push([
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    // turn_budget is a host-only control event (not persisted into r.events);
    // capture it via onEvent.
    const seen: Event[] = [];
    const deps = { ...f.deps(), maxTurns: 4, onEvent: async (e: Event) => { seen.push(e); } };
    await runAgent({ history: [], userText: "go" }, deps);
    const budgets = seen.filter((e) => e.type === "turn_budget");
    expect(budgets.length).toBeGreaterThan(0);
    // Governing ceiling is the finite maxTurns (no convergence cap lower).
    for (const b of budgets) {
      expect(b.type === "turn_budget" && b.maxTurns).toBe(4);
    }
    // The last two turns (remaining <= 2) carry the warning flag.
    const warned = budgets.filter((b) => b.type === "turn_budget" && b.warning === true);
    expect(warned.length).toBeGreaterThanOrEqual(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lowers the no-progress lock via config.convergence.noProgressLock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // Read-only calls make no durable progress; a low lock threshold should
    // disable tools early (toolChoice:"none") well before the default of 16.
    provider.responses = [];
    for (let i = 0; i < 10; i++) {
      provider.responses.push([
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "echo", input: { x: String(i) } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.config.convergence = { noProgressLock: 3, noProgressStrong: 2, noProgressSoft: 1 };
    const r = await runAgent({ history: [], userText: "spin read-only" }, deps);
    // The tool lock fires once the stall streak reaches the lowered threshold.
    const lockedIdx = provider.calls.findIndex((c) => c.toolChoice === "none");
    expect(lockedIdx).toBeGreaterThanOrEqual(0);
    expect(lockedIdx).toBeLessThan(8);
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // Exploration-stall track: a pure read-only investigation (no writes) that
  // keeps surfacing NEW evidence must NOT be wound down by the write ladder
  // (8/12/16) — only by the wider exploration ladder (12/18/24). These pin that
  // interaction and the gating of "new evidence".
  function liveText(opts: StreamChatOptions): string {
    return opts.messages
      .filter((m) => m.role === "system")
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
  }

  // Genuinely distinct per-turn intents (consecutive bigram-Jaccard well below
  // the 0.7 reworded-spin veto), so a turn's new read actually resets the
  // exploration track instead of being vetoed as restated spinning.
  const DISTINCT_INTENTS = [
    "Checking how the parser tokenizes nested blocks.",
    "Now I want to understand database retry timing.",
    "Let me trace where the auth header gets dropped.",
    "Investigating the cache eviction policy next.",
    "Does the scheduler respect task priority ordering?",
    "Looking into why websocket frames arrive late.",
    "Examining the migration that renamed the column.",
    "Reading the retry backoff math for correctness.",
    "Where does the config loader resolve defaults?",
    "Tracing the signal that cancels an in-flight job.",
    "How are temp files cleaned up on a crash here.",
    "Verifying the hash function distributes evenly.",
    "What path does an upload take before storage?",
    "Finding the lock that guards the write queue.",
    "Does compaction ever drop a pinned message?",
    "Studying how the sandbox maps host directories.",
    "Which module owns the session index rebuild?",
    "Checking the fallback when sqlite open fails.",
    "Reviewing the topological order of subtasks.",
    "How does the provider choose a small model?",
    "Reading the redaction patterns for secrets.",
    "Where is the turn budget ceiling computed?",
    "Tracing a steer message through the drain.",
    "Examining the artifact spill threshold logic.",
    "What triggers a force compaction on overflow?",
    "Looking at the plan-step status transitions.",
    "How are MCP resources listed and cached?",
    "Finding where image mentions get resolved.",
    "Does the reducer upsert user events by id?",
    "Checking the heartbeat on the daemon socket.",
  ];

  it("does not let the write ladder kill a read-only probe that keeps finding new evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    // 14 read_file turns, each with distinct input (dedup-cache MISS → new
    // evidence) and distinct intent text (no reworded-spin veto). This passes
    // the write ladder's lock point (16 is above 14, but the key check is that
    // the 8/12 soft/strong nudges — which tell it to "go write something" — do
    // NOT fire, because exploration progress resets turnsSinceNoProgress).
    provider.responses = [];
    for (let i = 0; i < 14; i++) {
      provider.responses.push([
        { kind: "text_delta", messageId: `m${i}`, text: DISTINCT_INTENTS[i]! },
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "read_file", input: { x: `src/file_${i}.ts` } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    provider.responses.push([
      { kind: "text_delta", messageId: "fin", text: "root cause identified" },
      { kind: "done", finishReason: "stop" },
    ]);
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 500;
    const r = await runAgent({ history: [], userText: "find the root cause" }, deps);
    // Ran all 14 probes + final text; never locked.
    expect(r.finalText).toBe("root cause identified");
    expect(provider.calls.every((c) => c.toolChoice === undefined)).toBe(true);
    // The write ladder's "no durable progress / go write something" nudges must
    // never have fired — this is a legitimate read-only investigation.
    const allSys = provider.calls.map(liveText).join("\n---\n");
    expect(allSys).not.toMatch(/no durable progress/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("winds down a read-only run at the exploration lock even while each read is 'new'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.honorToolChoiceNone = true;
    // 30 read_file turns, each with distinct input (always new evidence) and
    // distinct intent (no veto). The write ladder is held off, but the wider
    // exploration ladder (lock at 24) must eventually force synthesis so a
    // read-only run that keeps finding trivially-"new" reads still terminates.
    provider.responses = [];
    for (let i = 0; i < 30; i++) {
      provider.responses.push([
        { kind: "text_delta", messageId: `m${i}`, text: DISTINCT_INTENTS[i]! },
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "read_file", input: { x: `src/file_${i}.ts` } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 500;
    const r = await runAgent({ history: [], userText: "keep exploring" }, deps);
    // The exploration lock (24) fires: streak hits 24 at the end of turn index
    // 23, so the lock turn is call index 24 → 25 calls total.
    expect(provider.calls.length).toBe(25);
    expect(provider.calls[24]!.toolChoice).toBe("none");
    // Exactly one locking turn; it soft-lands on text.
    expect(provider.calls.filter((c) => c.toolChoice === "none").length).toBe(1);
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a repeated identical read as no new evidence (dedup replay is spinning)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.honorToolChoiceNone = true;
    // 20 read_file turns with the SAME input every turn → after the first, every
    // call is a dedup-cache replay ([dedup: prefix) = NOT new evidence. With no
    // exploration progress and no writes, the write ladder (lock at 16) governs,
    // firing well before the exploration ladder would. Intent varies so the veto
    // is not what stops it — the dedup replay is.
    provider.responses = [];
    for (let i = 0; i < 20; i++) {
      provider.responses.push([
        { kind: "text_delta", messageId: `m${i}`, text: `Attempt ${i}: let me look again at the configuration file contents here.` },
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "read_file", input: { x: "same/path.ts" } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 500;
    const r = await runAgent({ history: [], userText: "re-read in circles" }, deps);
    // The FIRST read is genuinely new evidence (resets the streak at turn 0);
    // every later identical read is a dedup replay = not new, so the write
    // ladder (lock at 16) governs from turn 1 → lock at call index 17 → 18
    // calls. The exploration ladder (24) never gets there.
    expect(provider.calls.length).toBe(18);
    expect(provider.calls[17]!.toolChoice).toBe("none");
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("vetoes an exploration reset when the intent is reworded spinning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.honorToolChoiceNone = true;
    // Distinct read inputs (each is 'new' by the dedup test) BUT the intent text
    // is near-identical every turn (reworded spin). The similarity veto must
    // cancel the write-ladder hold-off, so the write ladder (lock at 16) governs
    // — NOT the wider exploration ladder (24).
    provider.responses = [];
    for (let i = 0; i < 20; i++) {
      provider.responses.push([
        { kind: "text_delta", messageId: `m${i}`, text: "Next I will check the handler to understand the failure." },
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "read_file", input: { x: `src/file_${i}.ts` } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const f = makeDeps(dir, provider);
    const deps = f.deps();
    delete (deps as { maxTurns?: number }).maxTurns;
    deps.config = { ...deps.config };
    delete deps.config.maxTurns;
    deps.convergenceCap = 500;
    const r = await runAgent({ history: [], userText: "reworded spin" }, deps);
    // Turn 0 has no prior intent to compare against, so its new read resets the
    // streak; from turn 1 on, the near-identical intent trips the veto and the
    // write ladder (lock at 16) governs → lock at call index 17 → 18 calls. The
    // exploration ladder (24) never gets there.
    expect(provider.calls.length).toBe(18);
    expect(provider.calls[17]!.toolChoice).toBe("none");
    expect(r.events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not count an empty read result as new evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.honorToolChoiceNone = true;
    // A read tool that returns empty output every turn: never new evidence, so
    // the write ladder (lock at 16) governs. Register an empty-returning grep.
    const tools = new ToolRegistry();
    tools.register(makeTool("echo", "read", "echoed!"));
    tools.register(makeTool("write_file", "write", "wrote!"));
    tools.register({
      name: "grep",
      description: "mock grep",
      inputSchema: z.object({ x: z.string() }),
      permission: "read" as const,
      async execute() {
        return { content: "" };
      },
    });
    const artifacts = new ArtifactStore(join(dir, ".codepilot", "artifacts"));
    provider.responses = [];
    for (let i = 0; i < 20; i++) {
      provider.responses.push([
        { kind: "text_delta", messageId: `m${i}`, text: `Search ${i}: looking for a distinct symbol number ${i} across the tree.` },
        { kind: "tool_call", messageId: `m${i}`, toolCall: { type: "tool_use", id: `t${i}`, name: "grep", input: { x: `sym${i}` } } },
        { kind: "done", finishReason: "stop" },
      ]);
    }
    const deps: AgentDeps = {
      provider,
      tools,
      artifacts,
      permissions: new PermissionEngine({ permissionMode: "auto-edit" }),
      config: { provider: "anthropic" },
      cwd: dir,
      convergenceCap: 500,
    };
    const r = await runAgent({ history: [], userText: "empty searches" }, deps);
    // No new evidence (empty output) → write ladder locks at 16 → 17 calls.
    expect(provider.calls.length).toBe(17);
    expect(provider.calls[16]!.toolChoice).toBe("none");
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
      .find((c) => c.type === "text" && c.text.includes("no visible text"));
    expect(resumeMsg).toBeTruthy();
    expect(r.finalText).toBe("resumed and done");
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-continues after a degenerate EMPTY first response (no tools, no text)", async () => {
    // A provider can return a clean finishReason:stop with zero content blocks
    // on the VERY FIRST call (no
    // tool use at all). The old empty-stop resume required sawToolCalls, so
    // this degenerate completion slipped through as a silent blank reply to the
    // user/parent. Now it is retried (bounded) like any other empty stop.
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      // First call: completely empty successful stop — no tools, no text.
      [{ kind: "done", finishReason: "stop" }],
      // Retry produces the real answer.
      [
        { kind: "text_delta", messageId: "m2", text: "here is the answer" },
        { kind: "done", finishReason: "stop" },
      ],
    ];
    const f = makeDeps(dir, provider);
    const r = await runAgent({ history: [], userText: "go" }, f.deps());
    expect(provider.calls.length).toBe(2);
    expect(r.finalText).toBe("here is the answer");
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives up gracefully when a degenerate empty response never recovers", async () => {
    // Bounded by MAX_EMPTY_STOP_RESUMES so a model that always returns empty
    // can't loop forever: after the cap we yield the (empty) turn, not spin.
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const provider = new MockProvider();
    provider.responses = [
      [{ kind: "done", finishReason: "stop" }],
      [{ kind: "done", finishReason: "stop" }],
      [{ kind: "done", finishReason: "stop" }],
      [{ kind: "done", finishReason: "stop" }],
    ];
    const f = makeDeps(dir, provider);
    const r = await runAgent({ history: [], userText: "go" }, f.deps());
    // 1 initial + MAX_EMPTY_STOP_RESUMES (2) retries = 3 calls, then give up.
    expect(provider.calls.length).toBe(3);
    expect(r.finalText).toBe("");
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
