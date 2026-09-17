// Tests for the runtime toolkit (ROADMAP-NEXT §4.1 Phase 4) and the two
// example runtimes (Phase 3).

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { createRuntimeToolkit, runtimeRegistry } from "../src/runtime.js";
import {
  AuditRuntime,
  missingAuditSections,
  MctsRuntime,
  parseScores,
  selectCandidate,
  AUDIT_RUNTIME_NAME,
  MCTS_RUNTIME_NAME,
  type MctsCandidate,
} from "../src/runtimes/index.js";
import { runAgent, type AgentDeps } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import { HookEngine } from "../src/hooks.js";
import type { Event, ToolUseBlock } from "../src/types.js";
import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class MockProvider implements ChatProvider {
  readonly name = "mock";
  defaultModel = "mock-large";
  smallModel = "mock-small";
  /** One entry per expected stream() call. */
  responses: StreamEvent[][] = [];
  calls: StreamChatOptions[] = [];
  private idx = 0;
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    const i = this.idx++;
    if (i >= this.responses.length) {
      yield { kind: "text_delta", messageId: `m${i}`, text: "fallback" };
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    for (const ev of this.responses[i]!) yield ev;
  }
}

/** A stream that just says `text` and stops. */
function says(text: string, id = "m"): StreamEvent[] {
  return [
    { kind: "text_delta", messageId: id, text },
    { kind: "done", finishReason: "stop" },
  ];
}

const executed: string[] = [];

function makeDeps(cwd: string, provider: MockProvider, extra: Partial<AgentDeps> = {}): AgentDeps {
  const tools = new ToolRegistry();
  tools.register({
    name: "read_file",
    description: "read",
    inputSchema: z.object({ path: z.string() }),
    permission: "read" as const,
    async execute(input: { path: string }) {
      executed.push(`read_file:${input.path}`);
      return { content: `contents of ${input.path}` };
    },
  });
  tools.register({
    name: "write_file",
    description: "write",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    permission: "write" as const,
    async execute(input: { path: string }) {
      executed.push(`write_file:${input.path}`);
      return { content: `wrote ${input.path}` };
    },
  });
  return {
    provider,
    tools,
    artifacts: new ArtifactStore(join(cwd, ".codepilot", "artifacts")),
    permissions: new PermissionEngine({ permissionMode: "yolo" }),
    config: { model: "mock-large" } as never,
    cwd,
    ...extra,
  };
}

function call(name: string, input: unknown): ToolUseBlock {
  return { id: `tc_${name}`, name, input } as ToolUseBlock;
}

/** Tool names the provider was offered on a given stream() call. */
function offeredTools(provider: MockProvider, callIndex = 0): string[] {
  return (provider.calls[callIndex]?.tools ?? []).map((t) => t.name);
}

let cwd: string;
beforeEach(() => {
  executed.length = 0;
  cwd = mkdtempSync(join(tmpdir(), "codepilot-rtex-"));
  return () => rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Toolkit
// ---------------------------------------------------------------------------

describe("RuntimeToolkit", () => {
  it("runDefault behaves like runAgent", async () => {
    const a = new MockProvider();
    a.responses = [says("hello")];
    const direct = await runAgent({ history: [], userText: "hi" }, makeDeps(cwd, a));

    const b = new MockProvider();
    b.responses = [says("hello")];
    const viaToolkit = await createRuntimeToolkit().runDefault(
      { history: [], userText: "hi" },
      makeDeps(cwd, b),
    );
    expect(viaToolkit.finalText).toBe(direct.finalText);
    expect(viaToolkit.events.length).toBe(direct.events.length);
  });

  it("runTool executes a tool and returns its output", async () => {
    const deps = makeDeps(cwd, new MockProvider());
    const r = await createRuntimeToolkit().runTool(
      call("read_file", { path: "a.ts" }),
      deps,
      async () => undefined,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toBe("contents of a.ts");
    expect(executed).toEqual(["read_file:a.ts"]);
  });

  it("runTool honours a blocking PreToolUse hook", async () => {
    // This is the guarantee Phase 4 is about: a custom runtime that runs
    // tools through the toolkit cannot bypass the user's hooks.
    const deps = makeDeps(cwd, new MockProvider(), {
      hooks: new HookEngine(
        { PreToolUse: [{ matcher: "write_file", command: "exit 2" }] },
        cwd,
      ),
    });
    const r = await createRuntimeToolkit().runTool(
      call("write_file", { path: "a.ts", content: "x" }),
      deps,
      async () => undefined,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked by PreToolUse hook/);
    expect(executed).toEqual([]);
  });

  it("runTool appends PostToolUse hook feedback", async () => {
    const deps = makeDeps(cwd, new MockProvider(), {
      hooks: new HookEngine(
        { PostToolUse: [{ matcher: "*", command: "echo reviewed-by-hook" }] },
        cwd,
      ),
    });
    const r = await createRuntimeToolkit().runTool(
      call("read_file", { path: "a.ts" }),
      deps,
      async () => undefined,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/reviewed-by-hook/);
  });

  it("runTool refuses a write tool in a read-only mode", async () => {
    const deps = makeDeps(cwd, new MockProvider());
    const r = await createRuntimeToolkit().runTool(
      call("write_file", { path: "a.ts", content: "x" }),
      deps,
      async () => undefined,
      "chat",
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not allowed in chat mode/);
    expect(executed).toEqual([]);
  });

  it("runTool validates input before execution", async () => {
    const deps = makeDeps(cwd, new MockProvider());
    const r = await createRuntimeToolkit().runTool(
      call("read_file", { nope: 1 }),
      deps,
      async () => undefined,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/invalid arguments/);
    expect(executed).toEqual([]);
  });

  it("gives tools an auxiliary event channel that bypasses the transcript", async () => {
    // The `task` tool's team mode narrates through ctx.emitEvent. Those
    // events must reach the host (UI + persistence) without landing in the
    // run's own event list, which the loop indexes positionally.
    const hostEvents: Event[] = [];
    const deps = makeDeps(cwd, new MockProvider(), {
      onEvent: async (e) => void hostEvents.push(e),
    });
    // Stands in for the `task` tool's team mode: a tool that narrates its
    // internal progress instead of only returning a final result.
    deps.tools.register({
      name: "narrate",
      description: "emit an auxiliary event",
      inputSchema: z.object({ text: z.string() }),
      permission: "read" as const,
      async execute(input: { text: string }, toolCtx) {
        await toolCtx.emitEvent?.({
          type: "team_message",
          from: "worker-1",
          to: "all",
          content: input.text,
          timestamp: 1,
          kind: "status",
        });
        return { content: "narrated" };
      },
    });
    const loopEvents: Event[] = [];
    const r = await createRuntimeToolkit().runTool(
      call("narrate", { text: "member started" }),
      deps,
      async (e) => void loopEvents.push(e),
    );
    expect(r.isError).toBe(false);
    const team = hostEvents.filter((e) => e.type === "team_message");
    expect(team).toHaveLength(1);
    expect(loopEvents.some((e) => e.type === "team_message")).toBe(false);
  });

  it("visibleTools reflects the collaboration mode", () => {
    const deps = makeDeps(cwd, new MockProvider());
    const toolkit = createRuntimeToolkit();
    expect(toolkit.visibleTools(deps, "agent")).toEqual(["read_file", "write_file"]);
    expect(toolkit.visibleTools(deps, "chat")).toEqual(["read_file"]);
  });

  it("redactToolOutput strips credentials", () => {
    const out = createRuntimeToolkit().redactToolOutput(
      "token=ghp_abcdefghijklmnopqrstuvwxyz0123",
    );
    expect(out).not.toMatch(/ghp_abcdefghij/);
    expect(out).toMatch(/REDACTED/);
  });
});

describe("registry wiring", () => {
  it("pre-registers the example runtimes", () => {
    expect(runtimeRegistry.has(AUDIT_RUNTIME_NAME)).toBe(true);
    expect(runtimeRegistry.has(MCTS_RUNTIME_NAME)).toBe(true);
  });

  it("supplies a toolkit to factories that did not get one", () => {
    let received: unknown;
    const reg = runtimeRegistry;
    reg.register({
      name: "toolkit-probe",
      create: (deps) => {
        received = deps.toolkit;
        return {
          name: "toolkit-probe",
          async prompt() {
            return { events: [], hadToolCalls: false, finalText: "" };
          },
          cancel() {},
          state() {
            return "idle" as const;
          },
        };
      },
    });
    reg.resolve("toolkit-probe", { cwd });
    expect(received).toMatchObject({ version: 1 });
    reg.unregister("toolkit-probe");
  });
});

// ---------------------------------------------------------------------------
// Audit runtime
// ---------------------------------------------------------------------------

const GOOD_REPORT = [
  "## Summary",
  "Reviewed the auth module.",
  "## Findings",
  "### Hardcoded secret",
  "- **Severity**: high",
  "## Recommendations",
  "1. Move the secret to env.",
].join("\n");

describe("missingAuditSections", () => {
  it("accepts a conforming report", () => {
    expect(missingAuditSections(GOOD_REPORT)).toEqual([]);
  });

  it("names every missing section", () => {
    expect(missingAuditSections("## Summary\nall good")).toEqual([
      "Findings",
      "Recommendations",
    ]);
  });

  it("ignores case and heading depth", () => {
    expect(
      missingAuditSections("# summary\nx\n### FINDINGS\ny\n## recommendations\nz"),
    ).toEqual([]);
  });
});

describe("AuditRuntime", () => {
  it("exposes only read-only tools to the model", async () => {
    const provider = new MockProvider();
    provider.responses = [says(GOOD_REPORT)];
    const runtime = new AuditRuntime(createRuntimeToolkit());
    await runtime.prompt({ history: [], userText: "audit auth" }, makeDeps(cwd, provider));
    expect(offeredTools(provider)).toEqual(["read_file"]);
    expect(offeredTools(provider)).not.toContain("write_file");
  });

  it("injects the report contract into the prompt", async () => {
    const provider = new MockProvider();
    provider.responses = [says(GOOD_REPORT)];
    const runtime = new AuditRuntime(createRuntimeToolkit());
    await runtime.prompt(
      { history: [], userText: "audit auth" },
      makeDeps(cwd, provider, {
        systemPrompt: { staticPrefix: "STATIC", dynamicSuffix: "DYN", full: "STATIC\nDYN" },
      }),
    );
    // The contract rides in the dynamic suffix (appended to the last user
    // message), leaving the cacheable static prefix untouched.
    expect(provider.calls[0]?.systemPrompt).toBe("STATIC");
    const lastUser = provider.calls[0]?.messages.at(-1);
    const text = JSON.stringify(lastUser?.content);
    expect(text).toMatch(/audit_runtime/);
    expect(text).toMatch(/## Recommendations/);
  });

  it("does not spend a repair turn on a conforming report", async () => {
    const provider = new MockProvider();
    provider.responses = [says(GOOD_REPORT)];
    const runtime = new AuditRuntime(createRuntimeToolkit());
    const result = await runtime.prompt(
      { history: [], userText: "audit auth" },
      makeDeps(cwd, provider),
    );
    expect(provider.calls).toHaveLength(1);
    expect(result.finalText).toBe(GOOD_REPORT);
    expect(result.events.some((e) => e.type === "error")).toBe(false);
  });

  it("spends one turn repairing a malformed report", async () => {
    const provider = new MockProvider();
    provider.responses = [says("looks fine to me"), says(GOOD_REPORT)];
    const runtime = new AuditRuntime(createRuntimeToolkit());
    const result = await runtime.prompt(
      { history: [], userText: "audit auth" },
      makeDeps(cwd, provider),
    );
    expect(provider.calls).toHaveLength(2);
    // The repair turn names the sections that were missing.
    const repair = JSON.stringify(provider.calls[1]?.messages);
    expect(repair).toMatch(/missing these required sections/);
    expect(repair).toMatch(/Summary/);
    expect(result.finalText).toBe(GOOD_REPORT);
    expect(result.events.some((e) => e.type === "error")).toBe(false);
  });

  it("reports an unrecoverable contract violation instead of passing it off", async () => {
    const provider = new MockProvider();
    provider.responses = [says("nope"), says("still nope")];
    const emitted: Event[] = [];
    const runtime = new AuditRuntime(createRuntimeToolkit());
    const result = await runtime.prompt(
      { history: [], userText: "audit auth" },
      makeDeps(cwd, provider, { onEvent: (e) => void emitted.push(e) }),
    );
    const err = result.events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err && err.type === "error" && err.message).toMatch(/still missing/);
    expect(err && err.type === "error" && err.recoverable).toBe(true);
    expect(emitted.some((e) => e.type === "error")).toBe(true);
  });

  it("skips repair entirely when configured with zero attempts", async () => {
    const provider = new MockProvider();
    provider.responses = [says("nope")];
    const runtime = new AuditRuntime(createRuntimeToolkit(), { maxRepairAttempts: 0 });
    await runtime.prompt({ history: [], userText: "x" }, makeDeps(cwd, provider));
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses to start in agent mode", () => {
    expect(
      () =>
        new AuditRuntime(createRuntimeToolkit(), {
          mode: "agent" as never,
        }),
    ).toThrow(/read-only guarantee/);
  });

  it("can run in plan mode when the audit should leave notes", async () => {
    const provider = new MockProvider();
    provider.responses = [says(GOOD_REPORT)];
    const runtime = new AuditRuntime(createRuntimeToolkit(), { mode: "plan" });
    const deps = makeDeps(cwd, provider);
    await runtime.prompt({ history: [], userText: "x" }, deps);
    // Still read-only for user files: write_file never reaches the model.
    expect(offeredTools(provider)).not.toContain("write_file");
  });
});

// ---------------------------------------------------------------------------
// MCTS runtime
// ---------------------------------------------------------------------------

describe("parseScores", () => {
  it("parses a bare JSON array", () => {
    const m = parseScores('[{"index":1,"score":7,"reason":"ok"},{"index":2,"score":9}]');
    expect(m.get(1)).toEqual({ score: 7, reason: "ok" });
    expect(m.get(2)).toEqual({ score: 9, reason: undefined });
  });

  it("digs the array out of prose and code fences", () => {
    const m = parseScores('Here you go:\n```json\n[{"index":1,"score":3}]\n```\nDone.');
    expect(m.get(1)?.score).toBe(3);
  });

  it("clamps out-of-range scores and drops malformed entries", () => {
    const m = parseScores('[{"index":1,"score":42},{"index":2,"score":"high"},{"score":5}]');
    expect(m.get(1)?.score).toBe(10);
    expect(m.has(2)).toBe(false);
    expect(m.size).toBe(1);
  });

  it("returns nothing for unparseable text", () => {
    expect(parseScores("the candidates are all fine").size).toBe(0);
    expect(parseScores("[not json").size).toBe(0);
  });
});

describe("selectCandidate", () => {
  const c = (index: number, score?: number): MctsCandidate => ({
    index,
    angle: `a${index}`,
    text: `t${index}`,
    score,
  });

  it("picks the highest score", () => {
    expect(selectCandidate([c(1, 4), c(2, 9), c(3, 6)]).index).toBe(2);
  });

  it("breaks ties toward the earlier candidate", () => {
    expect(selectCandidate([c(1, 8), c(2, 8)]).index).toBe(1);
  });

  it("falls back to the first candidate when scoring produced nothing", () => {
    expect(selectCandidate([c(1), c(2)]).index).toBe(1);
  });
});

describe("MctsRuntime", () => {
  it("explores, scores, selects, then exploits", async () => {
    const provider = new MockProvider();
    provider.responses = [
      says("approach A"),
      says("approach B"),
      says('[{"index":2,"score":9,"reason":"cleaner"},{"index":1,"score":4}]'),
      says("implemented approach B"),
    ];
    const emitted: Event[] = [];
    const runtime = new MctsRuntime(createRuntimeToolkit(), { candidates: 2 });
    const result = await runtime.prompt(
      { history: [], userText: "refactor auth" },
      makeDeps(cwd, provider, { onEvent: (e) => void emitted.push(e) }),
    );

    expect(provider.calls).toHaveLength(4);
    // Exploration is read-only; only the exploit phase sees write tools.
    expect(offeredTools(provider, 0)).not.toContain("write_file");
    expect(offeredTools(provider, 1)).not.toContain("write_file");
    expect(offeredTools(provider, 3)).toContain("write_file");

    const candidates = runtime.candidates();
    expect(candidates.map((c) => c.text)).toEqual(["approach A", "approach B"]);
    expect(candidates[1]?.score).toBe(9);

    // The exploit prompt carries the winning approach.
    expect(JSON.stringify(provider.calls[3]?.messages)).toMatch(/approach B/);
    expect(result.finalText).toBe("implemented approach B");

    // The scoreboard is in the transcript, marking the winner.
    const note = emitted.find(
      (e) => e.type === "message" && JSON.stringify(e.content).includes("[mcts runtime]"),
    );
    expect(note).toBeDefined();
    expect(JSON.stringify(note)).toMatch(/selected #2/);
  });

  it("keeps the scoring round-trip out of the transcript", async () => {
    const provider = new MockProvider();
    provider.responses = [
      says("approach A"),
      says("approach B"),
      says('[{"index":1,"score":5}]'),
      says("done"),
    ];
    const emitted: Event[] = [];
    const runtime = new MctsRuntime(createRuntimeToolkit(), { candidates: 2 });
    await runtime.prompt(
      { history: [], userText: "task" },
      makeDeps(cwd, provider, { onEvent: (e) => void emitted.push(e) }),
    );
    // Quotes are backslash-escaped inside the stringified transcript.
    const transcript = JSON.stringify(emitted);
    expect(transcript).not.toMatch(/phase=\\"simulate/);
    expect(transcript).toMatch(/phase=\\"expand/);
  });

  it("returns the winning approach without exploiting when proposeOnly is set", async () => {
    const provider = new MockProvider();
    provider.responses = [
      says("approach A"),
      says("approach B"),
      says('[{"index":2,"score":8}]'),
    ];
    const runtime = new MctsRuntime(createRuntimeToolkit(), {
      candidates: 2,
      proposeOnly: true,
    });
    const result = await runtime.prompt(
      { history: [], userText: "task" },
      makeDeps(cwd, provider),
    );
    expect(provider.calls).toHaveLength(3);
    expect(result.finalText).toBe("approach B");
  });

  it("reads its options from config.runtimeOptions", async () => {
    const provider = new MockProvider();
    provider.responses = [says("A"), says("B"), says("C"), says('[{"index":1,"score":5}]')];
    const runtime = new MctsRuntime(createRuntimeToolkit());
    const deps = makeDeps(cwd, provider);
    deps.config = {
      model: "mock-large",
      runtimeOptions: { mcts: { candidates: 3, proposeOnly: true } },
    } as never;
    await runtime.prompt({ history: [], userText: "task" }, deps);
    // 3 exploration rollouts + 1 scoring pass, no exploit phase.
    expect(provider.calls).toHaveLength(4);
  });

  it("clamps the candidate count to a sane range", async () => {
    const provider = new MockProvider();
    provider.responses = Array.from({ length: 10 }, (_, i) => says(`c${i}`));
    const runtime = new MctsRuntime(createRuntimeToolkit(), {
      candidates: 99,
      proposeOnly: true,
    });
    await runtime.prompt({ history: [], userText: "task" }, makeDeps(cwd, provider));
    // 5 rollouts (the ceiling) + 1 scoring pass.
    expect(provider.calls).toHaveLength(6);
  });

  it("stops exploring once the run is cancelled", async () => {
    const provider = new MockProvider();
    provider.responses = [says("A"), says("B"), says("C")];
    const controller = new AbortController();
    const runtime = new MctsRuntime(createRuntimeToolkit(), { candidates: 3 });
    const deps = makeDeps(cwd, provider, { signal: controller.signal });
    controller.abort();
    const result = await runtime.prompt({ history: [], userText: "task" }, deps);
    expect(provider.calls).toHaveLength(0);
    expect(result.finalText).toBe("");
  });
});
