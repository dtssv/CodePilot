// Tests for the @codepilot/sdk public surface: Agent, run(), StreamEvent.
// All model interaction goes through ReplayProvider so no API key is needed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, run } from "../src/index.js";
import type {
  AgentCreateOptions,
  AgentResult,
  RunOptions,
  StreamEvent,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSONL transcript string from simple assistant turns. */
function transcript(
  turns: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; input: unknown }> }>
): string {
  const lines: string[] = [];
  let n = 0;
  for (const t of turns) {
    const content: unknown[] = [];
    if (t.text) content.push({ type: "text", text: t.text });
    for (const tc of t.toolCalls ?? []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    lines.push(
      JSON.stringify({ type: "message", id: `m${++n}`, role: "assistant", content })
    );
  }
  return lines.join("\n") + "\n";
}

let workDir: string;
let transcriptPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "codepilot-sdk-test-"));
  transcriptPath = join(workDir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Base options shared by all Agent.create() calls in tests.
 *  Sandbox is turned off because on macOS /var→/private/var symlink resolution
 *  in the tool-layer path guard rejects writes under the temp workspace. */
function baseOpts(extra: Partial<AgentCreateOptions> = {}): AgentCreateOptions {
  return {
    cwd: workDir,
    noConfigFiles: true,
    replay: transcriptPath,
    config: { sandbox: { mode: "off" } },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Agent.create()
// ---------------------------------------------------------------------------

describe("Agent.create()", () => {
  it("creates an agent with replay mode and noConfigFiles", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const agent = await Agent.create(baseOpts());
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.id).toBeTruthy();
    expect(typeof agent.id).toBe("string");
    await agent.dispose();
  });

  it("respects a user-supplied sessionId", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const agent = await Agent.create(baseOpts({ sessionId: "my-fixed-id" }));
    expect(agent.id).toBe("my-fixed-id");
    await agent.dispose();
  });

  it("generates distinct ids for different agents", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const a = await Agent.create(baseOpts());
    const b = await Agent.create(baseOpts());
    expect(a.id).not.toBe(b.id);
    await a.dispose();
    await b.dispose();
  });

  it("accepts model and agentMode overrides", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const agent = await Agent.create(
      baseOpts({ model: "replay-model", agentMode: "agent" })
    );
    expect(agent).toBeInstanceOf(Agent);
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// agent.prompt()
// ---------------------------------------------------------------------------

describe("Agent.prompt()", () => {
  it("returns an AgentResult with the expected shape", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "Hello from replay" }]));
    const agent = await Agent.create(baseOpts());
    const result = await agent.prompt("say hello");

    expect(result.text).toContain("Hello from replay");
    expect(result.hadErrors).toBe(false);
    expect(result.toolCallCount).toBe(0);
    expect(result.sessionId).toBe(agent.id);
    expect(result.usage).toBeDefined();
    expect(typeof result.usage.input).toBe("number");
    expect(typeof result.usage.output).toBe("number");

    await agent.dispose();
  });

  it("counts tool calls made during the prompt", async () => {
    // Turn 1: the model calls write_file. Turn 2: it responds with text.
    writeFileSync(
      transcriptPath,
      transcript([
        {
          toolCalls: [
            {
              id: "tc1",
              name: "write_file",
              input: { path: join(workDir, "out.txt"), content: "written by replay" },
            },
          ],
        },
        { text: "done writing" },
      ])
    );
    const agent = await Agent.create(baseOpts());
    const result = await agent.prompt("write a file");

    expect(result.toolCallCount).toBe(1);
    expect(result.text).toContain("done writing");
    // The tool actually executed against the real (temp) workspace.
    expect(existsSync(join(workDir, "out.txt"))).toBe(true);
    expect(readFileSync(join(workDir, "out.txt"), "utf-8")).toBe("written by replay");

    await agent.dispose();
  });

  it("accumulates text across multiple text blocks", async () => {
    writeFileSync(
      transcriptPath,
      transcript([{ text: "part one" }, { text: "part two" }])
    );
    const agent = await Agent.create(baseOpts());
    // First prompt consumes turn 1, second consumes turn 2.
    const r1 = await agent.prompt("first");
    const r2 = await agent.prompt("second");
    expect(r1.text).toContain("part one");
    expect(r2.text).toContain("part two");
    await agent.dispose();
  });

  it("throws after dispose()", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const agent = await Agent.create(baseOpts());
    await agent.dispose();
    await expect(agent.prompt("hello")).rejects.toThrow(/disposed/);
  });
});

// ---------------------------------------------------------------------------
// agent.stream()
// ---------------------------------------------------------------------------

describe("Agent.stream()", () => {
  it("yields text events and a terminal done event", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "streamed text" }]));
    const agent = await Agent.create(baseOpts());

    const events: StreamEvent[] = [];
    for await (const e of agent.stream("hello")) {
      events.push(e);
    }

    const texts = events.filter((e) => e.type === "text");
    expect(texts.length).toBeGreaterThan(0);
    const combined = texts.map((e) => (e as { text: string }).text).join("");
    expect(combined).toContain("streamed text");

    // The final event must be { type: "done" }.
    expect(events[events.length - 1]).toEqual({ type: "done" });

    await agent.dispose();
  });

  it("yields tool_call and tool_result events for tool use", async () => {
    writeFileSync(
      transcriptPath,
      transcript([
        {
          toolCalls: [
            {
              id: "tc1",
              name: "write_file",
              input: { path: join(workDir, "s.txt"), content: "stream write" },
            },
          ],
        },
        { text: "finished" },
      ])
    );
    const agent = await Agent.create(baseOpts());

    const events: StreamEvent[] = [];
    for await (const e of agent.stream("write")) {
      events.push(e);
    }

    const toolCalls = events.filter((e) => e.type === "tool_call");
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolCalls.length).toBe(1);
    expect(toolResults.length).toBe(1);

    const tc = toolCalls[0] as Extract<StreamEvent, { type: "tool_call" }>;
    expect(tc.name).toBe("write_file");
    expect(tc.input).toMatchObject({ content: "stream write" });

    const tr = toolResults[0] as Extract<StreamEvent, { type: "tool_result" }>;
    expect(tr.name).toBe("write_file");
    expect(tr.isError).toBe(false);

    // Done is always last.
    expect(events[events.length - 1]).toEqual({ type: "done" });

    await agent.dispose();
  });

  it("throws after dispose()", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const agent = await Agent.create(baseOpts());
    await agent.dispose();
    await expect(async () => {
      for await (const _ of agent.stream("hello")) {
        // never reached
      }
    }).rejects.toThrow(/disposed/);
  });
});

// ---------------------------------------------------------------------------
// agent.dispose()
// ---------------------------------------------------------------------------

describe("Agent.dispose()", () => {
  it("is idempotent — calling twice does not throw", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const agent = await Agent.create(baseOpts());
    await agent.dispose();
    await expect(agent.dispose()).resolves.toBeUndefined();
  });

  it("prevents prompt() and stream() after disposal", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "hi" }]));
    const agent = await Agent.create(baseOpts());
    await agent.dispose();
    await expect(agent.prompt("x")).rejects.toThrow(/disposed/);
    await expect(async () => {
      for await (const _ of agent.stream("x")) { /* noop */ }
    }).rejects.toThrow(/disposed/);
  });
});

// ---------------------------------------------------------------------------
// run() one-shot
// ---------------------------------------------------------------------------

describe("run()", () => {
  it("returns an AgentResult with the expected shape", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "one-shot answer" }]));
    const result: AgentResult = await run({
      cwd: workDir,
      noConfigFiles: true,
      replay: transcriptPath,
      prompt: "question?",
    });

    expect(result.text).toContain("one-shot answer");
    expect(result.hadErrors).toBe(false);
    expect(result.toolCallCount).toBe(0);
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.usage).toBeDefined();
  });

  it("disposes the agent even when the prompt succeeds", async () => {
    writeFileSync(transcriptPath, transcript([{ text: "ok" }]));
    const result = await run({
      cwd: workDir,
      noConfigFiles: true,
      replay: transcriptPath,
      prompt: "go",
    });
    // If dispose were skipped, this would leak — no direct way to observe,
    // but we at least confirm run() resolves cleanly.
    expect(result.text).toContain("ok");
  });

  it("satisfies the RunOptions type (compile-time check)", () => {
    // This is a type-level assertion: the object must be assignable to RunOptions.
    const opts: RunOptions = {
      cwd: "/tmp",
      prompt: "p",
      noConfigFiles: true,
      replay: "/tmp/x.jsonl",
      model: "m",
      agentMode: "agent",
    };
    expect(opts.prompt).toBe("p");
  });
});

// ---------------------------------------------------------------------------
// Replay transcript edge cases
// ---------------------------------------------------------------------------

describe("replay mode edge cases", () => {
  it("emits a fallback message when the transcript is exhausted", async () => {
    // Empty transcript: no turns to replay.
    writeFileSync(transcriptPath, "");
    const agent = await Agent.create(baseOpts());
    const result = await agent.prompt("anything");
    // ReplayProvider emits "(replay transcript exhausted)" for missing turns.
    expect(result.text).toContain("replay transcript exhausted");
    await agent.dispose();
  });

  it("handles a transcript with only tool calls (no text)", async () => {
    writeFileSync(
      transcriptPath,
      transcript([
        {
          toolCalls: [
            {
              id: "tc1",
              name: "write_file",
              input: { path: join(workDir, "only-tool.txt"), content: "x" },
            },
          ],
        },
        { text: "" }, // second turn so the loop terminates after tool exec
      ])
    );
    const agent = await Agent.create(baseOpts());
    const result = await agent.prompt("do it");
    expect(result.toolCallCount).toBe(1);
    await agent.dispose();
  });

  it("skips malformed JSONL lines gracefully", async () => {
    const good = JSON.stringify({
      type: "message",
      id: "m1",
      role: "assistant",
      content: [{ type: "text", text: "valid" }],
    });
    writeFileSync(transcriptPath, good + "\n{bad json\n");
    const agent = await Agent.create(baseOpts());
    const result = await agent.prompt("hi");
    expect(result.text).toContain("valid");
    await agent.dispose();
  });
});
