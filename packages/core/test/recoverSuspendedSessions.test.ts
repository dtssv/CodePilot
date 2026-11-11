// Boot-time crash-recovery sweep + durable-execution claim (K-A1-2).
//
// recoverSuspendedSessions() enumerates sessions whose JSONL tail is an
// in-flight status (a run interrupted by a crash / daemon kill) and seals each
// to a clean idle — orphaned tool calls get a side-effect-safe result and a
// trailing idle status is appended. It is seal-and-idle only: it never
// re-enters the agent loop. A real prompt writes an opening `running` status
// carrying the claim so the sweep (and later resumers) can key off it.

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session } from "../src/session.js";
import {
  sessionPath,
  SESSIONS_DIR,
  recoverSuspendedSessions,
} from "../src/session-utils.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

const silentProvider: ChatProvider = {
  name: "mock",
  defaultModel: "mock-model",
  smallModel: "mock-model",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { kind: "done", finishReason: "stop" };
  },
};

function seedSession(id: string, events: Event[]): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    sessionPath(id),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
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

describe("durable-execution claim written at prompt start", () => {
  let dir: string;
  let session: Session | undefined;
  const ids: string[] = [];

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    session = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const id of ids) cleanup(id);
    ids.length = 0;
  });

  it("appends a `running` status carrying claim metadata before the agent loop", async () => {
    dir = mkdtempSync(join(tmpdir(), "claim-"));
    const id = `claim_${Date.now()}_a`;
    ids.push(id);
    session = new Session(id, {
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
    await session.init();
    const claimSeen = new Promise<Extract<Event, { type: "status" }>>((resolve) => {
      session!.subscribe((e) => {
        if (e.type === "status" && e.status === "running" && e.claim) {
          resolve(e as Extract<Event, { type: "status" }>);
        }
      });
    });
    void session.prompt("hello");
    const claimStatus = await claimSeen;
    session.cancel();
    // Let the cancelled turn settle so the trailing idle is written.
    await new Promise((r) => setTimeout(r, 50));

    expect(claimStatus.claim!.executionId).toMatch(/^exec_/);
    expect(claimStatus.claim!.turn).toBe(1);
    expect(claimStatus.claim!.model).toBe("mock-model");
    expect(typeof claimStatus.claim!.startedAt).toBe("number");

    // The claim is persisted to the JSONL (survives a crash for the sweep).
    const persisted = readPersisted(id);
    expect(
      persisted.some((e) => e.type === "status" && e.status === "running" && e.claim),
    ).toBe(true);
  });
});

describe("recoverSuspendedSessions boot sweep", () => {
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids) cleanup(id);
    ids.length = 0;
  });

  it("seals suspended sessions to idle and reports them; leaves clean ones alone", async () => {
    const stamp = Date.now();
    const suspendedId = `recover_${stamp}_suspended`;
    const cleanId = `recover_${stamp}_clean`;
    ids.push(suspendedId, cleanId);

    // Suspended: tail is a `running` status with a claim + an unanswered call.
    seedSession(suspendedId, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      {
        type: "status",
        status: "running",
        claim: {
          executionId: "exec_x",
          turn: 1,
          model: "mock-model",
          fingerprint: "2:u1",
          startedAt: stamp,
        },
      },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "bash", input: {} }],
      },
      { type: "tool_call", id: "call_1", name: "bash", input: {} },
    ]);
    // Clean: ends on idle.
    seedSession(cleanId, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "status", status: "idle" },
    ]);

    const recovered = await recoverSuspendedSessions();

    // The suspended session is reported with its claim + sealed count.
    const mine = recovered.find((r) => r.id === suspendedId);
    expect(mine).toBeDefined();
    expect(mine!.recovery.sealedToolCalls).toBe(1);
    expect(mine!.recovery.claim?.executionId).toBe("exec_x");
    // The clean session is NOT reported.
    expect(recovered.some((r) => r.id === cleanId)).toBe(false);

    // On disk, the suspended session is now sealed: orphan tool_result + idle.
    const sealed = readPersisted(suspendedId);
    expect(
      sealed.some((e) => e.type === "tool_result" && e.toolCallId === "call_1" && e.isError),
    ).toBe(true);
    const lastStatus = [...sealed]
      .reverse()
      .find((e) => e.type === "status") as Extract<Event, { type: "status" }>;
    expect(lastStatus.status).toBe("idle");

    // The clean session is byte-for-byte unchanged (two events).
    expect(readPersisted(cleanId)).toHaveLength(2);
  });

  it("is idempotent — a second sweep finds nothing to seal", async () => {
    const stamp = Date.now();
    const id = `recover_${stamp}_idem`;
    ids.push(id);
    seedSession(id, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      { type: "status", status: "running" },
    ]);

    const first = await recoverSuspendedSessions();
    expect(first.some((r) => r.id === id)).toBe(true);

    const second = await recoverSuspendedSessions();
    expect(second.some((r) => r.id === id)).toBe(false);
  });
});
