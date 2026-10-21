import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, listSessions, getSessionsDir } from "../src/session.js";
import type { Event } from "../src/types.js";

// HOME is redirected in test/setup.ts before this module is loaded, so
// SESSIONS_DIR inside session.ts resolves under the temp dir at import time.
const tempHome = process.env.HOME ?? tmpdir();

describe("Session", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "work-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("persists events as JSONL", async () => {
    const session = await createSession({ cwd: workDir });
    const seen: Event[] = [];
    const unsub = session.subscribe((e) => seen.push(e));
    unsub();
    const id = session.id;
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: "message",
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }) + "\n",
      "utf-8"
    );
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("hello");
  });

  it("replays events on subscribe", async () => {
    const id = "replay-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ type: "message", id: "m2", role: "assistant", content: [{ type: "text", text: "hello" }] }),
      ].join("\n") + "\n",
      "utf-8"
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const seen: Event[] = [];
    session.subscribe((e) => seen.push(e));
    expect(seen.length).toBe(2);
    expect((seen[0] as { content: { text: string }[] }).content[0]?.text).toBe("hi");
  });

  it("prefers a model remembered from same-cwd session history over the config default", async () => {
 // A prior session in this cwd recorded model "glm-5.3" on its assistant turn.
    const priorId = "prior-model-sess";
    const priorPath = join(getSessionsDir(), `${priorId}.jsonl`);
    writeFileSync(
      priorPath,
      [
        JSON.stringify({ type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ type: "message", id: "a1", role: "assistant", model: "glm-5.3", content: [{ type: "text", text: "ok" }] }),
      ].join("\n") + "\n",
      "utf-8"
    );
    writeFileSync(join(getSessionsDir(), `${priorId}.cwd`), workDir, "utf-8");

 // A fresh session in the same cwd, with a different config default, should
 // still pick up the sticky model from history.
    const session = await createSession({
      cwd: workDir,
      config: { model: "some-default-model" },
    });
    expect(session.getModel()).toBe("glm-5.3");
  });

  it("reconciles a stale 'running' status to idle on resume", async () => {
    const id = "stale-running";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "go" }] }),
        JSON.stringify({ type: "status", status: "running" }),
      ].join("\n") + "\n",
      "utf-8"
    );
 // Resuming a session whose last status is "running" (interrupted by a
 // restart) must append an idle status so the UI stops showing it as busy.
    const session = await createSession({ cwd: workDir, sessionId: id });
    const text = readFileSync(path, "utf-8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[lines.length - 1]).toEqual({ type: "status", status: "idle" });
 // And the reconciling event replays to a fresh subscriber.
    const seen: Event[] = [];
    session.subscribe((e) => seen.push(e));
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({ type: "status", status: "idle" });
  });

  it("surfaces interrupt-recovery guidance in the system prompt after an interrupted resume", async () => {
    const id = "interrupted-with-ckpt";
    writeFileSync(
      join(getSessionsDir(), `${id}.jsonl`),
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "do the thing" }] }),
        JSON.stringify({ type: "status", status: "running" }), // cut off mid-run
      ].join("\n") + "\n",
      "utf-8",
    );
 // A checkpoint must exist for the recovery note (it points the model at it).
    mkdirSync(join(workDir, ".codepilot", "checkpoints"), { recursive: true });
    writeFileSync(
      join(workDir, ".codepilot", "checkpoints", `${id}.md`),
      "# Checkpoint\n\n## Task\nDo the thing.\n\n## Done\n- step 1\n",
      "utf-8",
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const prompt = session.getSystemPrompt();
    expect(prompt?.full).toContain("<interrupted_run>");
    expect(prompt?.full).toMatch(/do NOT repeat completed work/i);
  });

  it("does NOT add interrupt-recovery guidance to a cleanly-finished session", async () => {
    const id = "clean-finish";
    writeFileSync(
      join(getSessionsDir(), `${id}.jsonl`),
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ type: "status", status: "idle" }), // finished cleanly
      ].join("\n") + "\n",
      "utf-8",
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    expect(session.getSystemPrompt()?.full ?? "").not.toContain("<interrupted_run>");
  });

  it("cancel() with no active run notifies idle so the stop button always works", async () => {
    const session = await createSession({ cwd: workDir });
    const seen: Event[] = [];
    session.subscribe((e) => seen.push(e));
    seen.length = 0; // ignore any replay
    session.cancel(); // no prompt in flight
    const idle = seen.find((e) => e.type === "status" && e.status === "idle");
    expect(idle).toBeTruthy();
  });

  it("fork creates an independent session with shared prefix", async () => {
    const id = "fork-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "first" }] }) +
        "\n" +
        JSON.stringify({ type: "message", id: "m2", role: "assistant", content: [{ type: "text", text: "ans" }] }) +
        "\n",
      "utf-8"
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const forked = await session.fork(1);
    expect(forked.id).not.toBe(session.id);
    expect(forked.getEvents().length).toBe(1);
    expect(session.getEvents().length).toBe(2);
    await forked.dispose();
    await session.dispose();
  });

  it("getEvents returns the transcript", async () => {
    const id = "ge-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "message", id: "x", role: "user", content: [{ type: "text", text: "abc" }] }) + "\n",
      "utf-8"
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const events = session.getEvents();
    expect(events.length).toBe(1);
    expect((events[0] as { content: { text: string }[] }).content[0]?.text).toBe("abc");
  });

  it("listSessions returns summaries with cwd filter", async () => {
    const id = "list-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "message", id: "x", role: "user", content: [{ type: "text", text: "hello world" }] }) + "\n",
      "utf-8"
    );
    writeFileSync(join(getSessionsDir(), `${id}.cwd`), workDir, "utf-8");
    const summaries = await listSessions();
    const found = summaries.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.title).toContain("hello world");
    expect(found?.cwd).toBe(workDir);
    const filtered = await listSessions(workDir);
    expect(filtered.some((s) => s.id === id)).toBe(true);
    const other = await listSessions("/tmp/other-workspace-that-does-not-match");
    expect(other.some((s) => s.id === id)).toBe(false);
  });

  it("listSessions hides sessions with no messages yet", async () => {
    const id = "list-empty-draft";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(path, "", "utf-8");
    writeFileSync(join(getSessionsDir(), `${id}.cwd`), workDir, "utf-8");
    const summaries = await listSessions(workDir);
    expect(summaries.some((s) => s.id === id)).toBe(false);
  });
});


describe("Session tool wiring", () => {
  it("gives each session its own task / plan_done / memory_write wiring", async () => {
    const { taskTool } = await import("../src/tools/task.js");
    const before = taskTool.runner;
    const dirA = mkdtempSync(join(tempHome, "work-a-"));
    const dirB = mkdtempSync(join(tempHome, "work-b-"));
    try {
      const a = await createSession({ cwd: dirA });
      const b = await createSession({ cwd: dirB });
      type Reg = { toolRegistry: { get(n: string): Record<string, unknown> | undefined } };
      const tool = (s: unknown, name: string) => (s as Reg).toolRegistry.get(name)!;
      for (const name of ["task", "plan_done", "memory_write"]) {
        expect(tool(a, name)).not.toBe(tool(b, name));
      }
      expect(tool(a, "task").runner).toBeDefined();
      expect(tool(a, "task").runner).not.toBe(tool(b, "task").runner);
 // Creating sessions must not rewire the shared module object.
      expect(taskTool.runner).toBe(before);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
