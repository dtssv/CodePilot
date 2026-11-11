// Crash recovery: when a session's last persisted status is `running` (the
// prompt was cut off mid-turn), loading it must seal any tool call left without
// a result by appending a synthetic `tool_result` to the JSONL — so the source
// of truth is self-consistent (no orphaned tool_use) for export/replay/grep.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import { sessionPath, SESSIONS_DIR } from "../src/session-utils.js";
import { mkdirSync } from "node:fs";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

const silentProvider: ChatProvider = {
  name: "mock",
  defaultModel: "mock",
  smallModel: "mock",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { kind: "done", finishReason: "stop" };
  },
};

function seedSession(id: string, events: Event[]): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(sessionPath(id), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function readPersisted(id: string): Event[] {
  return readFileSync(sessionPath(id), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Event);
}

function cleanup(id: string): void {
  for (const suffix of ["jsonl", "title", "cwd", "state", "history.md"]) {
    const p = join(SESSIONS_DIR, `${id}.${suffix}`);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

describe("Session seals orphaned tool_calls on crash recovery", () => {
  let dir: string;
  let session: Session;
  const ids: string[] = [];

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const id of ids) cleanup(id);
    ids.length = 0;
  });

  function makeSession(id: string): Session {
    ids.push(id);
    return new Session(id, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        stopVerify: "off",
      },
      model: "mock-model",
      provider: silentProvider,
      pluginRuntimes: false,
    });
  }

  it("appends a synthetic tool_result for a tool_call left unanswered mid-run", async () => {
    dir = mkdtempSync(join(tmpdir(), "seal-"));
    const id = `seal_${Date.now()}_a`;
    // A crash transcript: user → assistant with a tool_use → NO tool_result →
    // status stuck at `running`.
    seedSession(id, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "do it" }] },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }],
      },
      { type: "tool_call", id: "call_1", name: "bash", input: { command: "ls" } },
      { type: "status", status: "running" },
    ]);

    session = makeSession(id);
    await session.init();

    const persisted = readPersisted(id);
    const sealed = persisted.filter((e) => e.type === "tool_result" && e.toolCallId === "call_1");
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.isError).toBe(true);
    expect(sealed[0]!.name).toBe("bash");
    // The final status is now idle, appended AFTER the seal.
    const lastStatus = [...persisted].reverse().find((e) => e.type === "status");
    expect(lastStatus?.status).toBe("idle");
    const sealIdx = persisted.findIndex((e) => e.type === "tool_result" && e.toolCallId === "call_1");
    const idleIdx = persisted.findIndex((e) => e.type === "status" && e.status === "idle");
    expect(sealIdx).toBeLessThan(idleIdx);
  });

  it("does not seal a tool_call that already has a result", async () => {
    dir = mkdtempSync(join(tmpdir(), "seal-ok-"));
    const id = `seal_${Date.now()}_b`;
    seedSession(id, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "do it" }] },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "bash", input: {} }],
      },
      { type: "tool_call", id: "call_1", name: "bash", input: {} },
      { type: "tool_result", toolCallId: "call_1", name: "bash", content: "done" },
      { type: "status", status: "running" },
    ]);

    session = makeSession(id);
    await session.init();

    const results = readPersisted(id).filter(
      (e) => e.type === "tool_result" && e.toolCallId === "call_1",
    );
    // Still exactly one — the original, not a second synthetic one.
    expect(results).toHaveLength(1);
    expect((results[0] as Extract<Event, { type: "tool_result" }>).content).toBe("done");
  });

  it("does nothing when the session ended cleanly (status idle)", async () => {
    dir = mkdtempSync(join(tmpdir(), "seal-clean-"));
    const id = `seal_${Date.now()}_c`;
    seedSession(id, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "bash", input: {} }],
      },
      { type: "tool_call", id: "call_1", name: "bash", input: {} },
      { type: "status", status: "idle" },
    ]);
    const before = readPersisted(id).length;

    session = makeSession(id);
    await session.init();

    // No seal: a cleanly-idle session is not a crash, even with a dangling call.
    const after = readPersisted(id);
    const sealed = after.filter((e) => e.type === "tool_result" && e.toolCallId === "call_1");
    expect(sealed).toHaveLength(0);
    expect(after.length).toBe(before);
  });

  it("surfaces an interrupted-run recovery (claim + sealed count) via getInterruptedRecovery", async () => {
    dir = mkdtempSync(join(tmpdir(), "seal-claim-"));
    const id = `seal_${Date.now()}_d`;
    // A crash transcript whose opening `running` carries a durable-execution
    // claim and left two tool calls unanswered.
    seedSession(id, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      {
        type: "status",
        status: "running",
        claim: {
          executionId: "exec_abc",
          turn: 1,
          model: "mock-model",
          fingerprint: "3:u1",
          startedAt: 1700000000000,
        },
      },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "bash", input: {} },
          { type: "tool_use", id: "call_2", name: "bash", input: {} },
        ],
      },
      { type: "tool_call", id: "call_1", name: "bash", input: {} },
      { type: "tool_call", id: "call_2", name: "bash", input: {} },
    ]);

    session = makeSession(id);
    await session.init();

    const recovery = session.getInterruptedRecovery();
    expect(recovery).toBeDefined();
    expect(recovery!.sessionId).toBe(id);
    expect(recovery!.sealedToolCalls).toBe(2);
    expect(recovery!.claim).toEqual({
      executionId: "exec_abc",
      turn: 1,
      model: "mock-model",
      startedAt: 1700000000000,
    });
  });

  it("leaves getInterruptedRecovery undefined for a cleanly-idle session", async () => {
    dir = mkdtempSync(join(tmpdir(), "seal-noclaim-"));
    const id = `seal_${Date.now()}_e`;
    seedSession(id, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "status", status: "idle" },
    ]);
    session = makeSession(id);
    await session.init();
    expect(session.getInterruptedRecovery()).toBeUndefined();
  });
});
