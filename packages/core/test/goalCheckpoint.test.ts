import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGoal } from "../src/goal.js";
import { getSessionsDir, deleteSession } from "../src/session.js";
import { ToolRegistry } from "../src/tools/types.js";
import { z } from "zod";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "../src/providers/types.js";
import { runAgent } from "../src/agent.js";
import { readCheckpoint, checkpointPath } from "../src/checkpoints.js";
import { writeCheckpoint } from "../src/checkpoints.js";
import { mkdirSync } from "node:fs";

/** A mock provider that emits a single assistant message and then a
 * goal-completion tag, so the goal loop sees the right marker. */
class GoalMockProvider implements ChatProvider {
  readonly name = "mock";
  defaultModel = "mock-large";
  smallModel = "mock-small";
  constructor(public readonly responses: StreamEvent[][]) {}
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const i = (opts as unknown as { _i?: number })._i ?? 0;
    (opts as unknown as { _i?: number })._i = i + 1;
    const plan = this.responses[i] ?? this.responses[this.responses.length - 1];
    if (!plan) {
      yield { kind: "done", finishReason: "stop" };
      return;
    }
    for (const ev of plan) yield ev;
  }
}

function makeEchoTool() {
  return {
    name: "echo",
    description: "echo",
    inputSchema: z.object({ x: z.string() }),
    permission: "read" as const,
    async execute() {
      return { content: "ok" };
    },
  };
}

const tempHome = process.env.HOME ?? tmpdir();

describe("runGoal — checkpoint integration", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "goal-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("emits an onCheckpoint callback per round when status reaches completed", async () => {
 // Direct test of the helper functions; we do NOT call runGoal
 // because that would invoke the real provider. Instead we exercise
 // the parts we can in isolation: writeCheckpoint + appendCheckpointRound
 // + the file system.
    const sessionId = "test-cb-completed";
    await writeCheckpoint(workDir, sessionId, []);
    const { appendCheckpointRound } = await import("../src/checkpoints.js");
    await appendCheckpointRound(workDir, sessionId, 1, "running", undefined, undefined);
    await appendCheckpointRound(workDir, sessionId, 2, "completed", "all done", undefined);
    const text = await readCheckpoint(workDir, sessionId);
    expect(text).toContain("### Round 1 — running");
    expect(text).toContain("### Round 2 — completed");
    expect(text).toContain("all done");
  });

  it("writes a structured blocked_reason into the checkpoint", async () => {
    const sessionId = "test-cb-blocked";
    await writeCheckpoint(workDir, sessionId, []);
    const { appendCheckpointRound } = await import("../src/checkpoints.js");
    await appendCheckpointRound(
      workDir,
      sessionId,
      1,
      "blocked",
      "missing creds",
      "GH_TOKEN not set"
    );
    const text = await readCheckpoint(workDir, sessionId);
    expect(text).toContain("### Round 1 — blocked");
    expect(text).toContain("missing creds");
    expect(text).toContain("GH_TOKEN not set");
    expect(text).toContain("Blocked reason");
  });

  it("checkpoint path is under ~/.codepilot/projects/<hash>/checkpoints/", () => {
    const p = checkpointPath(workDir, "abc");
    expect(p).toContain(".codepilot/projects/");
    expect(p).toContain("/checkpoints/abc.md");
    expect(p).not.toContain(join(workDir, ".codepilot"));
  });
});

describe("driveGoalRounds — busy session does not spin / pile up round prompts", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "goal-busy-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("waits for the session to drain before scanning when prompt() returns 'queued'", async () => {
    const { driveGoalRounds } = await import("../src/goal.js");

    // A minimal Session-shaped fake that reproduces the real race: the session
    // is "busy", so prompt() enqueues (returns "queued") instead of executing.
    // Without the waitUntilIdle() fix, driveGoalRounds would read stale events,
    // find no status marker, and spin — calling prompt() once per for-loop
    // iteration (the "7 identical OBJECTIVE" pile-up). With the fix it calls
    // waitUntilIdle(), and only then does the completion marker appear.
    const prompts: string[] = [];
    let events: Array<{ type: string; role?: string; content?: unknown }> = [];
    let busy = true;

    const fakeSession = {
      id: "busy-session",
      cwd: workDir,
      getConfig: () => ({}) as never,
      prompt: async (text: string) => {
        prompts.push(text);
        // Busy: the round prompt is enqueued, not executed; no new output yet.
        return "queued" as const;
      },
      waitUntilIdle: async () => {
        // The enqueued round prompt now runs and the model reports completed.
        busy = false;
        events = [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "<goal_status>completed</goal_status>" }],
          },
        ];
      },
      getEvents: () => events.slice(),
    } as unknown as import("../src/session.js").Session;

    const result = await driveGoalRounds(fakeSession, {
      objective: "do the thing",
      maxRounds: 10,
    });

    expect(result.status).toBe("completed");
    // The loop must NOT have spun: exactly one round prompt was sent, then it
    // waited and saw the completion marker — not 10 (maxRounds) pile-ups.
    expect(prompts.length).toBe(1);
    expect(busy).toBe(false);
  });
});

describe("driveGoalRounds — harness-level stall detection", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "goal-stall-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Build a fake Session whose per-round output is supplied by `rounds` — a
   * list of event arrays appended (cumulatively) each time prompt() runs. */
  function fakeStallSession(rounds: Array<Array<Record<string, unknown>>>) {
    let i = 0;
    const events: Array<Record<string, unknown>> = [];
    const session = {
      id: "stall-session",
      cwd: workDir,
      getConfig: () => ({}) as never,
      prompt: async () => {
        const batch = rounds[i] ?? [];
        i++;
        for (const e of batch) events.push(e);
        return "ok" as const;
      },
      waitUntilIdle: async () => {},
      getEvents: () => events.slice(),
    } as unknown as import("../src/session.js").Session;
    return { session };
  }

  const assistant = (text: string) => ({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
  });
  const writeCall = (id: string) => ({ type: "tool_call", id, name: "write_file", input: {} });
  const writeOk = (id: string) => ({ type: "tool_result", toolCallId: id, name: "write_file", content: "ok" });

  it("forces blocked after maxStalls consecutive no-progress rounds", async () => {
    const { driveGoalRounds } = await import("../src/goal.js");
    // Every round the agent only narrates — no writes, no shell, no plan step
    // completed, no status marker. With maxStalls=3 it must stop at round 3,
    // not burn all 20 rounds.
    const rounds = Array.from({ length: 20 }, () => [assistant("still thinking...")]);
    const { session } = fakeStallSession(rounds);
    const onStall: Array<{ round: number; stalls: number; limit: number }> = [];
    const result = await driveGoalRounds(session, {
      objective: "do the thing",
      maxRounds: 20,
      maxStalls: 3,
      onStall: (info) => void onStall.push(info),
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/no observable progress for 3 consecutive rounds/);
    // onStall fired once per idle round up to the limit.
    expect(onStall.map((s) => s.stalls)).toEqual([1, 2, 3]);
  });

  it("resets the stall counter when a round makes a write", async () => {
    const { driveGoalRounds } = await import("../src/goal.js");
    // Rounds: idle, idle, PRODUCTIVE (a write), idle, idle, then completed.
    // The productive round at index 2 resets the counter, so with maxStalls=3
    // the loop never force-blocks and instead reaches the completion marker.
    const rounds: Array<Array<Record<string, unknown>>> = [
      [assistant("thinking")],
      [assistant("still thinking")],
      [writeCall("c1"), writeOk("c1"), assistant("wrote a file")],
      [assistant("thinking again")],
      [assistant("more thinking")],
      [assistant("<goal_status>completed</goal_status>")],
    ];
    const { session } = fakeStallSession(rounds);
    const onStall: Array<{ round: number; stalls: number; limit: number }> = [];
    const result = await driveGoalRounds(session, {
      objective: "do the thing",
      maxRounds: 20,
      maxStalls: 3,
      onStall: (info) => void onStall.push(info),
    });
    expect(result.status).toBe("completed");
    // Idle at rounds 1,2 (stalls 1,2), reset by the write at round 3, idle at
    // rounds 4,5 (stalls 1,2) — never reaching the limit of 3.
    expect(onStall.map((s) => s.stalls)).toEqual([1, 2, 1, 2]);
  });

  it("does not force-block when stall detection is disabled (maxStalls=0)", async () => {
    const { driveGoalRounds } = await import("../src/goal.js");
    const rounds = Array.from({ length: 4 }, () => [assistant("idle")]);
    const { session } = fakeStallSession(rounds);
    const onStall: unknown[] = [];
    const result = await driveGoalRounds(session, {
      objective: "do the thing",
      maxRounds: 4,
      maxStalls: 0,
      onStall: (info) => void onStall.push(info),
    });
    // No stall blocking: it runs to the round cap instead.
    expect(result.status).toBe("round_limit");
    expect(onStall).toEqual([]);
  });
});

describe("extractBlockedReason via goalPromptBody behaviour", () => {
  it("recognises the standard marker set", async () => {
 // Smoke test for the exported regex array.
    const { COMPLETION_MARKERS } = await import("../src/goal.js");
    expect(COMPLETION_MARKERS.length).toBe(2);
    expect(/completed/i.test(COMPLETION_MARKERS[0]!.source)).toBe(true);
    expect(/blocked/i.test(COMPLETION_MARKERS[1]!.source)).toBe(true);
  });
});
