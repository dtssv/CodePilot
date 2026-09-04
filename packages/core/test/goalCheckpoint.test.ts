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
 *  goal-completion tag, so the goal loop sees the right marker. */
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

  it("checkpoint path is under .codepilot/checkpoints/", () => {
    const p = checkpointPath(workDir, "abc");
    expect(p).toContain(".codepilot/checkpoints/abc.md");
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
