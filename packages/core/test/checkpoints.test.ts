import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldCheckpoint as shouldCheckpointFn,
  writeCheckpoint,
  readCheckpoint,
  checkpointExists,
  checkpointPath,
  renderCheckpointMarkdown,
  parseCheckpointMarkdown,
  buildCheckpointSnapshot,
  appendCheckpointRound,
  summariseCheckpointForPrompt,
  CHECKPOINT_SECTIONS,
  makeCheckpointHook,
} from "../src/checkpoints.js";
import type { Event } from "../src/types.js";

function makeEvents(n: number, textPerMsg = 20): Event[] {
  const out: Event[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: "message",
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: "x".repeat(textPerMsg) + " " + i }],
    });
  }
  return out;
}

describe("shouldCheckpoint", () => {
  it("returns true when token estimate exceeds threshold", () => {
    const events = makeEvents(50, 200);
    const t = shouldCheckpointFn(events, null, { tokenThreshold: 100, turnsThreshold: 100 });
    expect(t.shouldCheckpoint).toBe(true);
    expect(t.estimatedTokens).toBeGreaterThan(0);
  });

  it("returns true when enough turns have passed", () => {
    const events = makeEvents(20, 5);
    const t = shouldCheckpointFn(events, null, { tokenThreshold: 1_000_000, turnsThreshold: 6 });
    expect(t.shouldCheckpoint).toBe(true);
    // makeEvents alternates user/assistant → 10 user messages.
    expect(t.turnsSinceLast).toBe(10);
  });

  it("returns false when below both thresholds", () => {
    const events = makeEvents(2, 5);
    const t = shouldCheckpointFn(events, null, { tokenThreshold: 1_000_000, turnsThreshold: 50 });
    expect(t.shouldCheckpoint).toBe(false);
  });

  it("counts turns since the last checkpoint boundary", () => {
    const events = makeEvents(20, 5);
    // Pretend a checkpoint covered the first 10 events; the 5 user
    // messages in [10..20) are the "since last" set.
    const t = shouldCheckpointFn(events, 10, { tokenThreshold: 1_000_000, turnsThreshold: 6 });
    expect(t.turnsSinceLast).toBe(5);
  });
});

describe("buildCheckpointSnapshot", () => {
  it("extracts the last user request as active intent", () => {
    const events: Event[] = [
      { type: "message", id: "1", role: "user", content: [{ type: "text", text: "first" }] },
      { type: "message", id: "2", role: "assistant", content: [{ type: "text", text: "ok" }] },
      { type: "message", id: "3", role: "user", content: [{ type: "text", text: "do X" }] },
    ];
    const snap = buildCheckpointSnapshot(events);
    expect(snap.activeIntent).toContain("do X");
  });

  it("renders the task tree with status icons", () => {
    const events: Event[] = [
      {
        type: "plan",
        steps: [
          { id: "1", title: "done", status: "completed" },
          { id: "2", title: "wip", status: "in_progress" },
          { id: "3", title: "next", status: "pending" },
        ],
      },
    ];
    const snap = buildCheckpointSnapshot(events);
    expect(snap.taskTree).toContain("✅");
    expect(snap.taskTree).toContain("🔄");
    expect(snap.taskTree).toContain("🔵");
    expect(snap.taskTree).toContain("done");
  });

  it("collects file paths from tool calls", () => {
    const events: Event[] = [
      { type: "tool_call", id: "t1", name: "write_file", input: { path: "src/foo.ts" } },
      { type: "tool_call", id: "t2", name: "read_file", input: { path: "src/bar.ts" } },
    ];
    const snap = buildCheckpointSnapshot(events);
    expect(snap.filesTouched).toContain("src/foo.ts");
    expect(snap.filesTouched).toContain("src/bar.ts");
  });

  it("collects errors and assistant-described fixes", () => {
    const events: Event[] = [
      { type: "error", message: "could not parse", recoverable: true },
      {
        type: "message",
        id: "a",
        role: "assistant",
        content: [{ type: "text", text: "Fixed by adding a guard clause." }],
      },
    ];
    const snap = buildCheckpointSnapshot(events);
    expect(snap.errorsFixes).toContain("could not parse");
    expect(snap.errorsFixes).toContain("Fixed");
  });
});

describe("render + parse round-trip", () => {
  it("renders all 7 sections", () => {
    const snap = buildCheckpointSnapshot([]);
    const md = renderCheckpointMarkdown(snap);
    for (const sec of CHECKPOINT_SECTIONS) {
      expect(md).toContain(`## ${sec}`);
    }
  });

  it("parses rendered markdown back to a snapshot", () => {
    const snap = buildCheckpointSnapshot([]);
    const md = renderCheckpointMarkdown(snap);
    const back = parseCheckpointMarkdown(md);
    expect(back.activeIntent).toBe(snap.activeIntent);
    expect(back.taskTree).toBe(snap.taskTree);
  });

  it("parses with case-insensitive section titles", () => {
    const md = `# H\n\n## ACTIVE INTENT\n\nmy goal\n\n## NEXT ACTION\n\ndo X\n`;
    const back = parseCheckpointMarkdown(md);
    expect(back.activeIntent).toBe("my goal");
    expect(back.nextAction).toBe("do X");
  });
});

describe("file persistence", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ckpt-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("writes and reads a checkpoint file", async () => {
    const id = "abc";
    const events = makeEvents(3, 100);
    const result = await writeCheckpoint(workDir, id, events, { tokenThreshold: 10 });
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toBe(checkpointPath(workDir, id));

    const text = await readCheckpoint(workDir, id);
    expect(text).toContain("Active intent");
  });

  it("checkpointExists returns true after a write", async () => {
    const id = "exists";
    await writeCheckpoint(workDir, id, []);
    expect(await checkpointExists(workDir, id)).toBe(true);
  });

  it("appends round-level blocks", async () => {
    const id = "rounds";
    await writeCheckpoint(workDir, id, []);
    await appendCheckpointRound(workDir, id, 1, "running", undefined, undefined);
    await appendCheckpointRound(workDir, id, 2, "blocked", undefined, "missing creds");
    const text = await readCheckpoint(workDir, id);
    expect(text).toContain("### Round 1 — running");
    expect(text).toContain("### Round 2 — blocked");
    expect(text).toContain("missing creds");
  });
});

describe("summariseCheckpointForPrompt", () => {
  it("truncates long checkpoints with a marker", () => {
    const md = renderCheckpointMarkdown(
      buildCheckpointSnapshot([]),
      "Checkpoint for abc"
    );
    const summary = summariseCheckpointForPrompt(md, 200);
    expect(summary).toContain("[Earlier-session checkpoint]");
    expect(summary.length).toBeLessThanOrEqual(400); // 200 + truncation note
  });

  it("keeps full content when under the cap", () => {
    const md = renderCheckpointMarkdown(buildCheckpointSnapshot([]));
    const summary = summariseCheckpointForPrompt(md, 100_000);
    expect(summary).toContain("[Earlier-session checkpoint]");
    expect(summary.length).toBeLessThan(md.length + 100);
  });
});

describe("makeCheckpointHook", () => {
  it("starts with no checkpoint and lastCheckpointAt = null", () => {
    const hook = makeCheckpointHook("/tmp", "x");
    expect(hook.hasCheckpoint).toBe(false);
    expect(hook.lastCheckpointAt).toBeNull();
  });

  it("check() reports a shouldCheckpoint result", () => {
    const hook = makeCheckpointHook("/tmp", "x");
    const t = hook.check(makeEvents(5, 10), { tokenThreshold: 10 });
    expect(typeof t.shouldCheckpoint).toBe("boolean");
  });
});
