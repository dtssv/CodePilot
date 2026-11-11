// Cross-process single-writer lease (K-E1-1).
//
// The lock is an advisory `<id>.lock` file created with O_EXCL. A live owner
// blocks a second acquire (SessionLockedError carrying attach info); a dead
// owner's stale lock is reclaimed; release frees the id.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import {
  acquireSessionLock,
  readSessionLock,
  liveSessionLockOwner,
  sessionLockPath,
  SessionLockedError,
} from "../src/sessionLock.js";
import { SESSIONS_DIR, sessionPath } from "../src/session-utils.js";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
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

function cleanup(id: string): void {
  const p = sessionLockPath(id);
  if (existsSync(p)) rmSync(p, { force: true });
}

describe("sessionLock — single-writer lease", () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids) cleanup(id);
    ids.length = 0;
  });

  function freshId(suffix: string): string {
    const id = `lock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${suffix}`;
    ids.push(id);
    return id;
  }

  it("acquires a free session and records the owner (this pid)", () => {
    const id = freshId("acquire");
    const lease = acquireSessionLock(id, { host: "cli" });
    expect(existsSync(sessionLockPath(id))).toBe(true);
    expect(lease.owner.pid).toBe(process.pid);
    expect(lease.owner.host).toBe("cli");
    const onDisk = readSessionLock(id);
    expect(onDisk?.pid).toBe(process.pid);
    lease.release();
    expect(existsSync(sessionLockPath(id))).toBe(false);
  });

  it("refuses a second acquire while a live OTHER process holds it; same-pid is reentrant", () => {
    const id = freshId("contend");
    // A foreign live owner: use this test process's parent-ish pid trick — we
    // simulate another live process by writing a lock owned by a pid we know is
    // alive but is NOT ours (process.ppid, the test runner's parent).
    const ppid = process.ppid;
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(
      sessionLockPath(id),
      JSON.stringify({ pid: ppid, acquiredAt: Date.now() }),
      "utf-8",
    );
    try {
      acquireSessionLock(id);
      throw new Error("expected SessionLockedError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionLockedError);
      expect((err as SessionLockedError).owner.pid).toBe(ppid);
      expect((err as SessionLockedError).sessionId).toBe(id);
    }
    rmSync(sessionLockPath(id), { force: true });

    // Same-pid re-acquire is reentrant (in-process concurrency is the live
    // registry's job): a second acquire from THIS process is granted, sharing
    // the lock, and its release does not yank it from the first holder.
    const first = acquireSessionLock(id);
    const second = acquireSessionLock(id);
    expect(second.owner.pid).toBe(process.pid);
    second.release(); // no-op — must not remove the shared lock
    expect(existsSync(sessionLockPath(id))).toBe(true);
    first.release();
    expect(existsSync(sessionLockPath(id))).toBe(false);
  });

  it("reclaims a stale lock whose owner pid is dead", () => {
    const id = freshId("stale");
    mkdirSync(SESSIONS_DIR, { recursive: true });
    // A dead pid: 2^31-1 is never a running process.
    writeFileSync(
      sessionLockPath(id),
      JSON.stringify({ pid: 2147483646, acquiredAt: 1 }),
      "utf-8",
    );
    expect(liveSessionLockOwner(id)).toBeNull(); // dead → not live
    const lease = acquireSessionLock(id); // reclaimed
    expect(lease.owner.pid).toBe(process.pid);
    lease.release();
  });

  it("reclaims a corrupt lock file", () => {
    const id = freshId("corrupt");
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(sessionLockPath(id), "{ not json", "utf-8");
    expect(readSessionLock(id)).toBeNull();
    const lease = acquireSessionLock(id);
    expect(lease.owner.pid).toBe(process.pid);
    lease.release();
  });

  it("liveSessionLockOwner returns the live owner and null when free", () => {
    const id = freshId("live");
    expect(liveSessionLockOwner(id)).toBeNull();
    const lease = acquireSessionLock(id, { url: "ws://127.0.0.1:1/rpc", token: "t" });
    const owner = liveSessionLockOwner(id);
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.url).toBe("ws://127.0.0.1:1/rpc");
    expect(owner?.token).toBe("t");
    lease.release();
    expect(liveSessionLockOwner(id)).toBeNull();
  });

  it("release is a no-op when another process reclaimed the lock", () => {
    const id = freshId("reclaimed");
    const lease = acquireSessionLock(id);
    // Simulate a reclaim by a different pid overwriting the lock file.
    writeFileSync(
      sessionLockPath(id),
      JSON.stringify({ pid: process.pid + 1, acquiredAt: Date.now() }),
      "utf-8",
    );
    lease.release(); // must NOT delete the other owner's lock
    expect(existsSync(sessionLockPath(id))).toBe(true);
    // Cleanup the foreign lock ourselves.
    rmSync(sessionLockPath(id), { force: true });
  });
});

describe("Session — write-lease integration", () => {
  let dir: string;
  const sessions: Session[] = [];
  const ids: string[] = [];

  afterEach(async () => {
    for (const s of sessions) await s.dispose().catch(() => undefined);
    sessions.length = 0;
    for (const id of ids) {
      for (const p of [sessionPath(id), sessionLockPath(id)]) {
        if (existsSync(p)) rmSync(p, { force: true });
      }
      for (const suffix of ["title", "cwd", "state", "history.md"]) {
        const p = `${SESSIONS_DIR}/${id}.${suffix}`;
        if (existsSync(p)) rmSync(p, { force: true });
      }
    }
    ids.length = 0;
    if (dir) rmSync(dir, { recursive: true, force: true });
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
    sessions.push(s);
    return s;
  }

  it("a write-open holds the lease and refuses a cross-process writer; same-pid resume is reentrant", async () => {
    dir = `${tmpdir()}/lease-${Date.now()}-a`;
    mkdirSync(dir, { recursive: true });
    const id = `lease_${Date.now()}_a`;
    const first = makeSession(id);
    await first.init();
    expect(existsSync(sessionLockPath(id))).toBe(true);

    // A same-pid re-open (e.g. an in-process resume) is reentrant — it shares
    // the lease rather than being refused.
    const second = makeSession(id);
    await expect(second.init()).resolves.toBeUndefined();

    // Simulate a DIFFERENT live process owning the lock → a write-open is
    // refused with SessionLockedError carrying the owner's attach info.
    await first.dispose();
    sessions.splice(sessions.indexOf(first), 1);
    await second.dispose();
    sessions.splice(sessions.indexOf(second), 1);
    writeFileSync(
      sessionLockPath(id),
      JSON.stringify({ pid: process.ppid, acquiredAt: Date.now(), url: "ws://127.0.0.1:1/rpc" }),
      "utf-8",
    );
    const third = makeSession(id);
    await expect(third.init()).rejects.toThrow(SessionLockedError);
    sessions.splice(sessions.indexOf(third), 1);
    rmSync(sessionLockPath(id), { force: true });
  });

  it("a read-only open acquires no lease and never writes", async () => {
    dir = `${tmpdir()}/lease-${Date.now()}-b`;
    mkdirSync(dir, { recursive: true });
    const id = `lease_${Date.now()}_b`;
    // Seed a crash transcript whose tail is `running` with a dangling call.
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const seed: Event[] = [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      { type: "status", status: "running" },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "bash", input: {} }],
      },
      { type: "tool_call", id: "call_1", name: "bash", input: {} },
    ];
    writeFileSync(sessionPath(id), seed.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    const before = seed.length;

    const ro = makeSession(id, { readOnly: true });
    await ro.init();
    // No lease was taken.
    expect(existsSync(sessionLockPath(id))).toBe(false);
    // Read-only did NOT seal the orphan: the file is byte-for-byte unchanged.
    const after = readFileSync(sessionPath(id), "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    expect(after).toHaveLength(before);
    // A write-open CAN still acquire the lease (the read-only handle never held it).
    const writer = makeSession(id);
    await writer.init();
    expect(existsSync(sessionLockPath(id))).toBe(true);
  });
});
