// Session retention + cold compression.
//
// Retention deletes non-pinned sessions older than `sessions.retentionDays`
// (0 = never) by mtime; pinned sessions are exempt. Cold compression converts
// a long-inactive `.jsonl` to a brotli `.jsonl.br` sibling, and the normal read
// paths (export / search / list / index) + a write-open session transparently
// decompress it. A session is EITHER live OR cold, never both.

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  SESSIONS_DIR,
  sessionPath,
  compressedSessionPath,
  compressSessionText,
  decompressSessionBuffer,
  readSessionJsonlText,
  exportSession,
  setSessionPinned,
  stateSidecarPath,
} from "../src/session-utils.js";
import {
  freezeSession,
  thawSession,
  isSessionCold,
  sweepSessionRetention,
  compressColdSessions,
  readColdSessionText,
} from "../src/sessionCompression.js";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { CodepilotConfig, Event } from "../src/types.js";

const silentProvider: ChatProvider = {
  name: "mock",
  defaultModel: "mock-model",
  smallModel: "mock-model",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { kind: "done", finishReason: "stop" };
  },
};

const ids: string[] = [];

function uid(tag: string): string {
  const id = `retn_${tag}_${Math.random().toString(36).slice(2, 10)}`;
  ids.push(id);
  return id;
}

function seed(id: string, events: Event[]): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(sessionPath(id), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function backdate(path: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  utimesSync(path, t, t);
}

const sampleEvents: Event[] = [
  { type: "message", role: "user", id: "msg_1", content: [{ type: "text", text: "hello retention" }], ts: 1 } as Event,
  { type: "message", role: "assistant", id: "msg_2", model: "m", content: [{ type: "text", text: "hi back" }], ts: 2 } as Event,
];

afterEach(() => {
  for (const id of ids.splice(0)) {
    for (const p of [
      sessionPath(id),
      compressedSessionPath(id),
      stateSidecarPath(id),
      `${id}.title`,
      `${id}.cwd`,
    ]) {
      try {
        rmSync(p.includes("/") ? p : join(SESSIONS_DIR, p), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

describe("brotli session codec", () => {
  it("round-trips JSONL text", () => {
    const text = sampleEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const back = decompressSessionBuffer(compressSessionText(text));
    expect(back).toBe(text);
  });
});

describe("freeze / thaw", () => {
  it("freeze compresses the plaintext away; thaw restores it", async () => {
    const id = uid("ft");
    seed(id, sampleEvents);
    expect(await isSessionCold(id)).toBe(false);

    expect(await freezeSession(id)).toBe(true);
    // Live plaintext is gone, cold sibling present.
    expect(existsSync(sessionPath(id))).toBe(false);
    expect(existsSync(compressedSessionPath(id))).toBe(true);
    expect(await isSessionCold(id)).toBe(true);
    // Cold content is still readable without materializing plaintext.
    const cold = await readColdSessionText(id);
    expect(cold).toContain("hello retention");

    expect(await thawSession(id)).toBe(true);
    expect(existsSync(sessionPath(id))).toBe(true);
    expect(existsSync(compressedSessionPath(id))).toBe(false);
    expect(readFileSync(sessionPath(id), "utf-8")).toContain("hi back");
  });

  it("thaw keeps the plaintext when both a live and cold file exist (crash recovery)", async () => {
    const id = uid("crash");
    seed(id, sampleEvents);
    // Simulate a crash mid-freeze: cold sibling written, plaintext not yet removed,
    // but the plaintext has newer content (an extra appended line).
    writeFileSync(compressedSessionPath(id), compressSessionText("STALE\n"));
    writeFileSync(sessionPath(id), "LIVE_NEWER\n", "utf-8");
    expect(await thawSession(id)).toBe(true);
    // Plaintext wins; stale cold copy is discarded.
    expect(readFileSync(sessionPath(id), "utf-8")).toBe("LIVE_NEWER\n");
    expect(existsSync(compressedSessionPath(id))).toBe(false);
  });

  it("freeze is a no-op for a session with no plaintext", async () => {
    const id = uid("none");
    expect(await freezeSession(id)).toBe(false);
  });
});

describe("read paths are cold-transparent", () => {
  it("exportSession and readSessionJsonlText read a cold session", async () => {
    const id = uid("read");
    seed(id, sampleEvents);
    await freezeSession(id);
    const jsonl = await exportSession(id, "jsonl");
    expect(jsonl).toContain("hello retention");
    const raw = await readSessionJsonlText(id);
    expect(raw).toContain("hi back");
  });
});

describe("write-open session thaws a cold transcript", () => {
  it("resumes a frozen session: replays history and removes the cold file", async () => {
    const id = uid("resume");
    seed(id, [
      { type: "status", status: "idle", ts: 1 } as Event,
      ...sampleEvents,
    ]);
    await freezeSession(id);
    expect(await isSessionCold(id)).toBe(true);

    const session = new Session(id, {
      cwd: SESSIONS_DIR,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        stopVerify: "off",
      } as unknown as CodepilotConfig,
      model: "mock-model",
      provider: silentProvider,
      pluginRuntimes: false,
    });
    try {
      await session.init();
      // The cold file was thawed to plaintext for the write-open session…
      expect(existsSync(sessionPath(id))).toBe(true);
      expect(existsSync(compressedSessionPath(id))).toBe(false);
      // …and the prior turns were replayed into history.
      const text = JSON.stringify(session.getHistory());
      expect(text).toContain("hello retention");
    } finally {
      await session.dispose().catch(() => undefined);
    }
  });
});

describe("retention sweep", () => {
  function cfg(retentionDays: number): CodepilotConfig {
    return { sessions: { retentionDays } } as unknown as CodepilotConfig;
  }

  it("is a no-op when retentionDays is 0", async () => {
    const id = uid("keep0");
    seed(id, sampleEvents);
    backdate(sessionPath(id), 100);
    const r = await sweepSessionRetention({ config: cfg(0) });
    expect(r.deleted).not.toContain(id);
    expect(existsSync(sessionPath(id))).toBe(true);
  });

  it("deletes a non-pinned session older than the cutoff, keeps a recent one", async () => {
    const old = uid("old");
    const fresh = uid("fresh");
    seed(old, sampleEvents);
    seed(fresh, sampleEvents);
    backdate(sessionPath(old), 10);
    // fresh keeps its current mtime (now)
    const r = await sweepSessionRetention({ config: cfg(1) });
    expect(r.deleted).toContain(old);
    expect(existsSync(sessionPath(old))).toBe(false);
    expect(existsSync(sessionPath(fresh))).toBe(true);
  });

  it("exempts a pinned session from retention", async () => {
    const id = uid("pinned");
    seed(id, sampleEvents);
    backdate(sessionPath(id), 30);
    await setSessionPinned(id, true);
    const r = await sweepSessionRetention({ config: cfg(1) });
    expect(r.deleted).not.toContain(id);
    expect(existsSync(sessionPath(id))).toBe(true);
  });

  it("deletes a cold (compressed) session past the cutoff", async () => {
    const id = uid("coldold");
    seed(id, sampleEvents);
    await freezeSession(id);
    backdate(compressedSessionPath(id), 10);
    const r = await sweepSessionRetention({ config: cfg(1) });
    expect(r.deleted).toContain(id);
    expect(existsSync(compressedSessionPath(id))).toBe(false);
  });
});

describe("cold-compress sweep", () => {
  function cfg(coldCompress: boolean, afterDays = 30): CodepilotConfig {
    return { sessions: { coldCompress, coldCompressAfterDays: afterDays } } as unknown as CodepilotConfig;
  }

  it("is a no-op when coldCompress is off", async () => {
    const id = uid("off");
    seed(id, sampleEvents);
    backdate(sessionPath(id), 100);
    const r = await compressColdSessions({ config: cfg(false) });
    expect(r.compressed).not.toContain(id);
    expect(existsSync(sessionPath(id))).toBe(true);
  });

  it("compresses a session past the inactivity threshold, leaves a warm one", async () => {
    const cold = uid("c");
    const warm = uid("w");
    seed(cold, sampleEvents);
    seed(warm, sampleEvents);
    backdate(sessionPath(cold), 40);
    // warm stays at now
    const r = await compressColdSessions({ config: cfg(true, 30) });
    expect(r.compressed).toContain(cold);
    expect(await isSessionCold(cold)).toBe(true);
    expect(existsSync(sessionPath(warm))).toBe(true);
    expect(await isSessionCold(warm)).toBe(false);
  });

  it("leaves a pinned session live", async () => {
    const id = uid("pinwarm");
    seed(id, sampleEvents);
    backdate(sessionPath(id), 40);
    await setSessionPinned(id, true);
    const r = await compressColdSessions({ config: cfg(true, 30) });
    expect(r.compressed).not.toContain(id);
    expect(await isSessionCold(id)).toBe(false);
  });

  it("skips an already-cold session (idempotent)", async () => {
    const id = uid("already");
    seed(id, sampleEvents);
    await freezeSession(id);
    backdate(compressedSessionPath(id), 40);
    const r = await compressColdSessions({ config: cfg(true, 30) });
    expect(r.compressed).not.toContain(id);
    expect(await isSessionCold(id)).toBe(true);
  });
});
