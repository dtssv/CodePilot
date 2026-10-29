import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionsDir,
  listSessions,
  loadSessionState,
  setSessionArchived,
  setSessionPinned,
  resetSessionIndex,
  persistSessionCwd,
} from "../src/session.js";

const tempHome = process.env.HOME ?? tmpdir();

function writeSession(id: string, user = "hi"): void {
  writeFileSync(
    join(getSessionsDir(), `${id}.jsonl`),
    JSON.stringify({ type: "message", id: "u1", role: "user", content: [{ type: "text", text: user }] }) + "\n",
    "utf-8",
  );
}

describe("session pin / archive", () => {
  beforeEach(() => {
    mkdirSync(getSessionsDir(), { recursive: true });
    resetSessionIndex();
  });
  afterEach(() => {
    resetSessionIndex();
  });

  it("round-trips archive state and clears it on unarchive", async () => {
    writeSession("arc-1");
    await setSessionArchived("arc-1", true);
    expect((await loadSessionState("arc-1")).archived).toBe(true);
    const list = await listSessions();
    expect(list.find((s) => s.id === "arc-1")?.archived).toBe(true);
    await setSessionArchived("arc-1", false);
    expect((await loadSessionState("arc-1")).archived).toBeUndefined();
  });

  it("pins at most one session per workspace", async () => {
    writeSession("pin-a");
    writeSession("pin-b");
    await persistSessionCwd("pin-a", "/work/proj");
    await persistSessionCwd("pin-b", "/work/proj");

    await setSessionPinned("pin-a", true);
    expect((await loadSessionState("pin-a")).pinned).toBe(true);

    // Pinning b in the same workspace unpins a.
    await setSessionPinned("pin-b", true);
    expect((await loadSessionState("pin-b")).pinned).toBe(true);
    expect((await loadSessionState("pin-a")).pinned).toBeUndefined();
  });

  it("pins are independent across workspaces", async () => {
    writeSession("w1-a");
    writeSession("w2-a");
    await persistSessionCwd("w1-a", "/work/one");
    await persistSessionCwd("w2-a", "/work/two");
    await setSessionPinned("w1-a", true);
    await setSessionPinned("w2-a", true);
    // Different workspaces → both stay pinned.
    expect((await loadSessionState("w1-a")).pinned).toBe(true);
    expect((await loadSessionState("w2-a")).pinned).toBe(true);
  });

  it("archiving clears a pin; pinning un-archives", async () => {
    writeSession("pz");
    await persistSessionCwd("pz", "/work/x");
    await setSessionPinned("pz", true);
    await setSessionArchived("pz", true);
    let st = await loadSessionState("pz");
    expect(st.archived).toBe(true);
    expect(st.pinned).toBeUndefined();
    await setSessionPinned("pz", true);
    st = await loadSessionState("pz");
    expect(st.pinned).toBe(true);
    expect(st.archived).toBeUndefined();
  });
});
