import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  listSessions,
  searchSessions,
  exportSession,
  deleteSession,
  getSessionsDir,
  resetSessionIndex,
} from "../src/session.js";
import type { Event } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

describe("session search & export", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "work-"));
 // Make sure the sessions dir exists before each test.
    mkdirSync(getSessionsDir(), { recursive: true });
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("listSessions returns enriched summaries (mode/model/messageCount)", async () => {
    const id = "enriched-1";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ type: "message", id: "m2", role: "assistant", content: [{ type: "text", text: "hello" }], model: "claude-sonnet-4-5" }),
      ].join("\n") + "\n",
      "utf-8"
    );
    const summaries = await listSessions();
    const found = summaries.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.messageCount).toBe(2);
    expect(found?.model).toBe("claude-sonnet-4-5");
  });

  it("searchSessions matches by title", async () => {
    const id = "search-title";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "anything" }] }) + "\n",
      "utf-8"
    );
    const out = await searchSessions("anything");
    expect(out.find((s) => s.id === id)).toBeDefined();
  });

  it("searchSessions matches by content", async () => {
    const id = "search-content";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", id: "u", role: "user", content: [{ type: "text", text: "Please refactor the typechecker" }] }),
        JSON.stringify({ type: "message", id: "a", role: "assistant", content: [{ type: "text", text: "Sure" }] }),
      ].join("\n") + "\n",
      "utf-8"
    );
    const out = await searchSessions("typechecker");
    expect(out.find((s) => s.id === id)).toBeDefined();
  });

  it("searchSessions with empty query returns everything", async () => {
    const out = await searchSessions("");
    expect(Array.isArray(out)).toBe(true);
  });

  it("searchSessions respects the limit", async () => {
    const id1 = "limit-a";
    const id2 = "limit-b";
    for (const id of [id1, id2]) {
      const path = join(getSessionsDir(), `${id}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "common" }] }) + "\n",
        "utf-8"
      );
    }
    const out = await searchSessions("common", { limit: 1 });
    expect(out.length).toBe(1);
  });

  it("exportSession returns jsonl when requested", async () => {
    const id = "export-jsonl";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    const event: Event = {
      type: "message",
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    writeFileSync(path, JSON.stringify(event) + "\n", "utf-8");
    const out = await exportSession(id, "jsonl");
    expect(out).toContain("user");
    expect(out).toContain("hi");
    const lines = out.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it("exportSession returns markdown when requested", async () => {
    const id = "export-md";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    const events: Event[] = [
      { type: "message", id: "m1", role: "user", content: [{ type: "text", text: "please help" }] },
      { type: "message", id: "m2", role: "assistant", content: [{ type: "text", text: "sure" }] },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    const out = await exportSession(id, "markdown");
    expect(out).toContain("# Session " + id);
    expect(out).toContain("**User**");
    expect(out).toContain("**Assistant**");
    expect(out).toContain("please help");
  });

  it("deleteSession removes the persisted file", async () => {
    const id = "to-delete";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "message", id: "m", role: "user", content: [{ type: "text", text: "x" }] }) + "\n", "utf-8");
    expect(existsSync(path)).toBe(true);
    await deleteSession(id);
    expect(existsSync(path)).toBe(false);
  });

  it("Session.setTitle persists to sidecar and getTitle reads it back", async () => {
    const session = await createSession({ cwd: workDir });
    await session.setTitle("My Custom Title");
    expect(session.getTitle()).toBe("My Custom Title");
    const sidecar = join(getSessionsDir(), `${session.id}.title`);
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(sidecar, "utf-8")).toBe("My Custom Title");
    await session.dispose();
  });
});

describe("session index ↔ full-scan parity", () => {
  // The SQLite index is a DERIVED cache; its correctness premise is that its
  // results EQUAL the authoritative full-scan path (sessionIndex.ts:64
  // "index results equal full-scan results"). These tests drive the public
  // listSessions/searchSessions with the index ON vs forced OFF
  // (CODEPILOT_SESSION_INDEX=off → full scan) and assert the two agree.
  let workDir: string;
  const ids = ["parity-alpha", "parity-beta", "parity-gamma"];

  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "parity-"));
    mkdirSync(getSessionsDir(), { recursive: true });
    // A known, isolated set of sessions with distinct titles/content/model.
    const specs: Array<{ id: string; user: string; model: string }> = [
      { id: ids[0]!, user: "alpha typechecker crash", model: "m-a" },
      { id: ids[1]!, user: "beta refactor plan", model: "m-b" },
      { id: ids[2]!, user: "gamma billing report", model: "m-c" },
    ];
    for (const s of specs) {
      writeFileSync(
        join(getSessionsDir(), `${s.id}.jsonl`),
        [
          JSON.stringify({ type: "message", id: "u", role: "user", content: [{ type: "text", text: s.user }] }),
          JSON.stringify({ type: "message", id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], model: s.model }),
        ].join("\n") + "\n",
        "utf-8",
      );
    }
  });
  afterEach(() => {
    delete process.env.CODEPILOT_SESSION_INDEX;
    resetSessionIndex();
    for (const id of ids) rmSync(join(getSessionsDir(), `${id}.jsonl`), { force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  // Keep only our known ids and the fields both paths populate, so the
  // comparison is stable regardless of other sessions in the shared test dir.
  const project = (rows: Array<{ id: string; title: string; model?: string; messageCount: number }>) =>
    rows
      .filter((r) => ids.includes(r.id))
      .map((r) => ({ id: r.id, title: r.title, model: r.model, messageCount: r.messageCount }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));

  it("listSessions returns identical summaries with the index on vs off", async () => {
    resetSessionIndex();
    const indexed = await listSessions();
    process.env.CODEPILOT_SESSION_INDEX = "off";
    resetSessionIndex();
    const fullScan = await listSessions();
    expect(project(indexed)).toEqual(project(fullScan));
    // Sanity: we actually exercised both and found our sessions.
    expect(project(indexed).length).toBe(ids.length);
  });

  it("searchSessions returns the same matches with the index on vs off", async () => {
    resetSessionIndex();
    const indexed = await searchSessions("typechecker");
    process.env.CODEPILOT_SESSION_INDEX = "off";
    resetSessionIndex();
    const fullScan = await searchSessions("typechecker");
    const onlyOurs = (rows: Array<{ id: string }>) => rows.map((r) => r.id).filter((id) => ids.includes(id));
    expect(onlyOurs(indexed)).toEqual(onlyOurs(fullScan));
    expect(onlyOurs(indexed)).toEqual([ids[0]]);
  });
});
