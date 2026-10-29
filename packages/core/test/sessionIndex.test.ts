import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionIndex, type SessionIndex } from "../src/sessionIndex.js";

function writeSession(
  dir: string,
  id: string,
  opts: { user?: string; assistant?: string; model?: string; mode?: string; messages?: boolean } = {},
): void {
  const lines: string[] = [];
  if (opts.mode) lines.push(JSON.stringify({ type: "mode", mode: opts.mode }));
  if (opts.messages !== false) {
    lines.push(
      JSON.stringify({ type: "message", id: "u1", role: "user", content: [{ type: "text", text: opts.user ?? "hi" }] }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: opts.assistant ?? "ok" }],
        ...(opts.model ? { model: opts.model } : {}),
      }),
    );
  }
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
}

describe("sessionIndex (SQLite metadata index)", () => {
  let dir: string | null = null;
  let idx: SessionIndex | null = null;

  afterEach(() => {
    idx?.close();
    idx = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function open(): SessionIndex {
    dir = mkdtempSync(join(tmpdir(), "sidx-"));
    const i = openSessionIndex(dir);
    expect(i, "better-sqlite3 should be available in tests").not.toBeNull();
    idx = i!;
    return idx;
  }

  it("lists sessions newest-first with enriched metadata", () => {
    const i = open();
    writeSession(dir!, "s1", { user: "first", model: "m-a", mode: "agent" });
    // Ensure s2 has a strictly newer mtime for deterministic ordering.
    writeSession(dir!, "s2", { user: "second", model: "m-b" });
    const now = Date.now() / 1000;
    utimesSync(join(dir!, "s1.jsonl"), now - 10, now - 10);
    utimesSync(join(dir!, "s2.jsonl"), now, now);
    const list = i.list();
    expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);
    const s1 = list.find((s) => s.id === "s1")!;
    expect(s1.title).toBe("first");
    expect(s1.model).toBe("m-a");
    expect(s1.mode).toBe("agent");
    expect(s1.messageCount).toBe(2);
  });

  it("excludes drafts (no messages yet)", () => {
    const i = open();
    writeSession(dir!, "draft", { messages: false });
    writeSession(dir!, "real", { user: "hello" });
    expect(i.list().map((s) => s.id)).toEqual(["real"]);
  });

  it("filters by cwd (strict; unknown excluded)", () => {
    const i = open();
    writeSession(dir!, "a", { user: "x" });
    writeSession(dir!, "b", { user: "y" });
    writeFileSync(join(dir!, "a.cwd"), "/work/alpha", "utf-8");
    writeFileSync(join(dir!, "b.cwd"), "/work/beta", "utf-8");
    const alpha = i.list("/work/alpha");
    expect(alpha.map((s) => s.id)).toEqual(["a"]);
  });

  it("searches metadata (title, cwd, first user message)", () => {
    const i = open();
    writeSession(dir!, "t", { user: "typechecker crash" });
    writeSession(dir!, "o", { user: "unrelated" });
    writeFileSync(join(dir!, "o.cwd"), "/projects/billing", "utf-8");
    expect(i.search("typechecker").map((s) => s.id)).toEqual(["t"]);
    // cwd match
    expect(i.search("billing").map((s) => s.id)).toEqual(["o"]);
    // empty query returns everything
    expect(i.search("").length).toBe(2);
    // limit respected
    expect(i.search("", { limit: 1 }).length).toBe(1);
  });

  it("title matches rank above body/cwd matches", () => {
    const i = open();
    writeSession(dir!, "body", { user: "mentions alpha deep in text" });
    writeSession(dir!, "titled", { user: "whatever" });
    writeFileSync(join(dir!, "titled.title"), "alpha release", "utf-8");
    const out = i.search("alpha");
    expect(out[0]!.id).toBe("titled"); // score 100 (title) before score 1 (body)
  });

  it("reconciles incrementally — picks up changed files, leaves others", () => {
    const i = open();
    writeSession(dir!, "s1", { user: "one" });
    writeSession(dir!, "s2", { user: "two" });
    expect(i.list().length).toBe(2);

    // Change only s2 (new content + newer mtime).
    writeSession(dir!, "s2", { user: "two edited" });
    const now = Date.now() / 1000;
    utimesSync(join(dir!, "s2.jsonl"), now + 5, now + 5);

    const list = i.list();
    expect(list.find((s) => s.id === "s2")!.title).toBe("two edited");
    expect(list.find((s) => s.id === "s1")!.title).toBe("one"); // untouched
  });

  it("picks up a title sidecar written after the session file", () => {
    const i = open();
    writeSession(dir!, "s1", { user: "initial prompt" });
    expect(i.list().find((s) => s.id === "s1")!.title).toBe("initial prompt");
    // Auto-title lands in a sidecar AFTER indexing — the stamp folds sidecar
    // mtimes, so the next list() reflects it.
    writeFileSync(join(dir!, "s1.title"), "A nicer title", "utf-8");
    const now = Date.now() / 1000;
    utimesSync(join(dir!, "s1.title"), now + 5, now + 5);
    expect(i.list().find((s) => s.id === "s1")!.title).toBe("A nicer title");
  });

  it("drops rows whose files are deleted", () => {
    const i = open();
    writeSession(dir!, "keep", { user: "a" });
    writeSession(dir!, "gone", { user: "b" });
    expect(i.list().length).toBe(2);
    unlinkSync(join(dir!, "gone.jsonl"));
    expect(i.list().map((s) => s.id)).toEqual(["keep"]);
  });

  it("survives a second index handle on the same dir (cross-process shape)", () => {
    const i = open();
    writeSession(dir!, "s1", { user: "shared" });
    expect(i.list().length).toBe(1);
    // A second handle (e.g. a standalone CLI process) opening the same index.db
    // must not error and must see the same row via WAL.
    const i2 = openSessionIndex(dir!);
    expect(i2).not.toBeNull();
    try {
      expect(i2!.list().map((s) => s.id)).toEqual(["s1"]);
      writeSession(dir!, "s2", { user: "added by proc 2" });
      const now = Date.now() / 1000;
      utimesSync(join(dir!, "s2.jsonl"), now + 5, now + 5);
      // i2 reconciles the new file; i1 then sees it too.
      expect(i2!.list().length).toBe(2);
      expect(i.list().length).toBe(2);
    } finally {
      i2!.close();
    }
  });

  it("returns null-safe when the directory does not exist yet", () => {
    const missing = join(tmpdir(), `sidx-missing-${Date.now()}`);
    const i = openSessionIndex(missing);
    // Open may still succeed (creates the file lazily); list on an empty/missing
    // dir yields an empty array without throwing.
    if (i) {
      expect(i.list()).toEqual([]);
      i.close();
      rmSync(missing, { recursive: true, force: true });
    }
  });
});
