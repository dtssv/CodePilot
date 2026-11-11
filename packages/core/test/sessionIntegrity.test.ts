// K-E1-2: JSONL physical integrity (torn-tail repair), content_replacement
// audit events for large-payload offload, and artifact mark-and-sweep GC.

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session } from "../src/session.js";
import { sessionPath, SESSIONS_DIR, deleteSession } from "../src/session-utils.js";
import {
  gcProjectArtifacts,
  collectSessionArtifactRefs,
} from "../src/artifactGc.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { projectStatePath } from "../src/projectState.js";
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

function readLines(id: string): string[] {
  return readFileSync(sessionPath(id), "utf-8").split("\n").filter((l) => l.length > 0);
}

function readPersisted(id: string): Event[] {
  return readFileSync(sessionPath(id), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Event);
}

function cleanup(id: string): void {
  for (const suffix of ["jsonl", "title", "cwd", "state", "history.md", "lock"]) {
    const p = join(SESSIONS_DIR, `${id}.${suffix}`);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

describe("torn-tail JSONL repair on load", () => {
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

  function makeSession(id: string, opts?: { readOnly?: boolean }): Session {
    ids.push(id);
    const s = new Session(id, {
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
      ...(opts?.readOnly ? { readOnly: true } : {}),
    });
    session = s;
    return s;
  }

  it("truncates a torn final line back to the last complete record", async () => {
    dir = mkdtempSync(join(tmpdir(), "torn-"));
    const id = `torn_${Date.now()}_a`;
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const good = [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "status", status: "idle" },
    ] as Event[];
    // A complete body followed by a torn (incomplete JSON, no newline) tail.
    const body = good.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(sessionPath(id), body + '{"type":"message","id":"u2"', "utf-8");

    const s = makeSession(id);
    await s.init();

    // The torn fragment is gone; the file ends on the last complete record.
    const lines = readLines(id);
    expect(lines).toHaveLength(2);
    expect(readFileSync(sessionPath(id), "utf-8").endsWith("\n")).toBe(true);
    expect(s.getTornTailRepairs()).toBe(1);
    // Every surviving line parses.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("restores a missing trailing newline when the last line is valid JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "torn-nl-"));
    const id = `torn_${Date.now()}_b`;
    mkdirSync(SESSIONS_DIR, { recursive: true });
    // Two complete records but NO trailing newline on the last.
    const line1 = JSON.stringify({ type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] });
    const line2 = JSON.stringify({ type: "status", status: "idle" });
    writeFileSync(sessionPath(id), line1 + "\n" + line2, "utf-8");

    const s = makeSession(id);
    await s.init();

    // No record dropped (both are valid); the missing newline is restored so
    // the next append starts on its own line. Not counted as a torn repair.
    expect(readFileSync(sessionPath(id), "utf-8").endsWith("\n")).toBe(true);
    expect(readLines(id)).toHaveLength(2);
    expect(s.getTornTailRepairs()).toBe(0);
  });

  it("leaves a cleanly-terminated file untouched", async () => {
    dir = mkdtempSync(join(tmpdir(), "torn-clean-"));
    const id = `torn_${Date.now()}_c`;
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const body =
      [
        { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
        { type: "status", status: "idle" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n";
    writeFileSync(sessionPath(id), body, "utf-8");

    const s = makeSession(id);
    await s.init();
    expect(readFileSync(sessionPath(id), "utf-8")).toBe(body);
    expect(s.getTornTailRepairs()).toBe(0);
  });

  it("a read-only open never repairs the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "torn-ro-"));
    const id = `torn_${Date.now()}_d`;
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const torn =
      JSON.stringify({ type: "status", status: "idle" }) + "\n" + '{"type":"message"';
    writeFileSync(sessionPath(id), torn, "utf-8");

    const s = makeSession(id, { readOnly: true });
    await s.init();
    // Byte-for-byte unchanged — read-only holds no write lease.
    expect(readFileSync(sessionPath(id), "utf-8")).toBe(torn);
    expect(s.getTornTailRepairs()).toBe(0);
  });
});

describe("content_replacement audit events", () => {
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

  it("records a content_replacement when a large tool_result is spilled to an artifact", async () => {
    dir = mkdtempSync(join(tmpdir(), "cr-"));
    const id = `cr_${Date.now()}_a`;
    ids.push(id);
    // A provider that calls bash once (emitting >8KB output that spills), then
    // stops. The spilled tool_result carries an artifactRef, which persistEvent
    // turns into a content_replacement audit record.
    let turn = 0;
    const toolProvider: ChatProvider = {
      name: "mock",
      defaultModel: "mock-model",
      smallModel: "mock-model",
      async *stream(): AsyncIterable<StreamEvent> {
        turn += 1;
        if (turn === 1) {
          yield {
            kind: "tool_call",
            messageId: "m1",
            toolCall: {
              type: "tool_use",
              id: "call_1",
              name: "bash",
              input: { command: "printf 'X%.0s' $(seq 1 12000)" },
            },
          };
          yield { kind: "done", finishReason: "tool_use" };
        } else {
          yield { kind: "text_delta", messageId: "m2", text: "done" };
          yield { kind: "done", finishReason: "stop" };
        }
      },
    };
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
      provider: toolProvider,
      pluginRuntimes: false,
    });
    await session.init();
    const recSeen = new Promise<Extract<Event, { type: "content_replacement" }>>((resolve) => {
      session!.subscribe((e) => {
        if (e.type === "content_replacement") {
          resolve(e as Extract<Event, { type: "content_replacement" }>);
        }
      });
    });
    void session.prompt("go");
    const liveRec = await recSeen;
    session.cancel();
    await new Promise((r) => setTimeout(r, 50));

    expect(liveRec.target).toBe("tool_result");
    expect(liveRec.ownerId).toBe("call_1");
    expect(liveRec.tool).toBe("bash");
    expect(liveRec.bytes).toBeGreaterThan(8_000);

    // And it is durably persisted alongside the spilled tool_result.
    const persisted = readPersisted(id);
    const tr = persisted.find(
      (e) => e.type === "tool_result" && e.artifactRef,
    ) as Extract<Event, { type: "tool_result" }> | undefined;
    expect(tr).toBeDefined();
    const rec = persisted.find(
      (e) => e.type === "content_replacement",
    ) as Extract<Event, { type: "content_replacement" }> | undefined;
    expect(rec).toBeDefined();
    expect(rec!.artifactRef).toBe(tr!.artifactRef);
  });
});

describe("artifact GC mark-and-sweep", () => {
  const ids: string[] = [];
  let projectCwd: string;

  afterEach(() => {
    for (const id of ids) cleanup(id);
    ids.length = 0;
    if (projectCwd) {
      rmSync(projectStatePath(projectCwd, "artifacts"), { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  function seedSession(id: string, cwd: string, events: Event[]): void {
    ids.push(id);
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(sessionPath(id), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    writeFileSync(join(SESSIONS_DIR, `${id}.cwd`), cwd, "utf-8");
  }

  it("deletes only artifacts no session references", async () => {
    projectCwd = mkdtempSync(join(tmpdir(), "gcproj-"));
    const store = new ArtifactStore(projectStatePath(projectCwd, "artifacts"));
    const refShared = await store.write("shared payload content here", "a");
    const refOnlyA = await store.write("only-A payload content here", "b");
    const refOrphan = await store.write("orphan payload nobody refs it", "c");

    const stamp = Date.now();
    const idA = `gc_${stamp}_a`;
    const idB = `gc_${stamp}_b`;
    // Session A references shared + onlyA (via tool_result + content_replacement).
    seedSession(idA, projectCwd, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      { type: "tool_result", toolCallId: "c1", name: "bash", content: "stub", artifactRef: refShared },
      { type: "content_replacement", ownerId: "c2", target: "tool_result", artifactRef: refOnlyA, bytes: 27, tool: "grep" },
    ] as Event[]);
    // Session B references shared only.
    seedSession(idB, projectCwd, [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "tool_result", toolCallId: "c1", name: "bash", content: "stub", artifactRef: refShared },
    ] as Event[]);

    const res = await gcProjectArtifacts(projectCwd);
    // Only the orphan is removed; shared + onlyA survive.
    expect(res.removed).toEqual([refOrphan]);
    expect(res.referenced).toBe(2);
    expect(existsSync(join(store.rootDir, `${refOrphan.slice(4)}.txt`))).toBe(false);
    expect(existsSync(join(store.rootDir, `${refShared.slice(4)}.txt`))).toBe(true);
    expect(existsSync(join(store.rootDir, `${refOnlyA.slice(4)}.txt`))).toBe(true);
  });

  it("collectSessionArtifactRefs finds refs across tool_result, image, and content_replacement", async () => {
    projectCwd = mkdtempSync(join(tmpdir(), "gcrefs-"));
    const id = `gcrefs_${Date.now()}`;
    seedSession(id, projectCwd, [
      { type: "tool_result", toolCallId: "c1", name: "bash", content: "s", artifactRef: "art_" + "a".repeat(64) },
      {
        type: "message",
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "see image" }],
        images: [{ mediaType: "png", ref: "art_" + "b".repeat(64) }],
      },
      { type: "content_replacement", ownerId: "c3", target: "image", artifactRef: "art_" + "c".repeat(64), bytes: 10 },
    ] as unknown as Event[]);

    const refs = await collectSessionArtifactRefs(id);
    expect(refs.has("art_" + "a".repeat(64))).toBe(true);
    expect(refs.has("art_" + "b".repeat(64))).toBe(true);
    expect(refs.has("art_" + "c".repeat(64))).toBe(true);
    expect(refs.size).toBe(3);
  });

  it("deleteSession reclaims that session's now-orphaned artifacts", async () => {
    projectCwd = mkdtempSync(join(tmpdir(), "gcdel-"));
    const store = new ArtifactStore(projectStatePath(projectCwd, "artifacts"));
    const refOnlyDeleted = await store.write("belongs to the deleted session", "x");
    const refKept = await store.write("belongs to the surviving session", "y");

    const stamp = Date.now();
    const idDel = `gcdel_${stamp}_d`;
    const idKeep = `gcdel_${stamp}_k`;
    seedSession(idDel, projectCwd, [
      { type: "tool_result", toolCallId: "c1", name: "bash", content: "s", artifactRef: refOnlyDeleted },
    ] as Event[]);
    seedSession(idKeep, projectCwd, [
      { type: "tool_result", toolCallId: "c1", name: "bash", content: "s", artifactRef: refKept },
    ] as Event[]);

    await deleteSession(idDel);

    // The deleted session's artifact is gone; the surviving session's is kept.
    expect(existsSync(join(store.rootDir, `${refOnlyDeleted.slice(4)}.txt`))).toBe(false);
    expect(existsSync(join(store.rootDir, `${refKept.slice(4)}.txt`))).toBe(true);
    expect(existsSync(sessionPath(idDel))).toBe(false);
  });
});
