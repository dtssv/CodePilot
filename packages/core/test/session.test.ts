import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
    const summaries = await listSessions();
    const found = summaries.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.title).toContain("hello world");
  });
});

