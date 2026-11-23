import { describe, expect, it } from "vitest";
import { applyEdit } from "../src/tools/edit_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("applyEdit", () => {
  it("exact single replacement", () => {
    const r = applyEdit("hello world", { search: "world", replace: "there" });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("exact");
    expect(r.message).toBe("hello there");
  });

  it("rejects identical search/replace as a no-op", () => {
    const r = applyEdit("hello world", { search: "hello", replace: "hello" });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("validate");
    expect(r.message).toMatch(/identical|no changes/i);
  });

  it("ambiguous exact match without global_replace", () => {
    const r = applyEdit("foo foo foo", { search: "foo", replace: "bar" });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("exact");
    expect(r.message).toMatch(/ambiguous/);
  });

  it("global_replace replaces all occurrences", () => {
    const r = applyEdit("foo foo foo", {
      search: "foo",
      replace: "bar",
      global_replace: true,
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("exact");
    expect(r.message).toBe("bar bar bar");
  });

  it("falls back to trimmed-line match", () => {
    const original = "function foo() {\n  return 1;\n}\n";
    const r = applyEdit(original, {
      search: "function foo() {\n  return 1;\n}",
      replace: "function foo() {\n  return 2;\n}",
    });
 // Exact match should win (whitespace is identical).
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("exact");
  });

  it("trimmed-lines match is hint-only (does not write; indent-safe)", () => {
    const original = "function foo() {\n    return 1;\n}\n";
    const r = applyEdit(original, {
      search: "function foo() {\n  return 1;\n}",
      replace: "function foo() {\n  return 2;\n}",
    });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("trimmed-lines");
    expect(r.message).toMatch(/not applied|exact indentation/i);
    expect(original).toContain("return 1");
  });

  it("single-line unique match", () => {
    const original = "a\nb\nc\n";
    const r = applyEdit(original, { search: "b", replace: "B" });
 // exact match wins first
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("exact");
    expect(r.message).toBe("a\nB\nc\n");
  });

  it("single-line ambiguous fails without global", () => {
    const r = applyEdit("a\na\n", { search: "a", replace: "X" });
    expect(r.ok).toBe(false);
 // exact path is hit first
    expect(r.strategy).toBe("exact");
  });

  it("regex mode", () => {
    const r = applyEdit("a 1 b 22 c", {
      search: "\\d+",
      replace: "#",
      regex: true,
      global_replace: true,
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe("a # b # c");
  });

  it("regex without match returns error", () => {
    const r = applyEdit("hello", { search: "x+", replace: "y", regex: true });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("regex");
  });

  it("typographic match: smart quotes in search, straight quotes in source", () => {
    // Source has straight quotes; the model copied the line with curly quotes.
    const original = 'const msg = "hello";\n';
    const r = applyEdit(original, {
      search: 'const msg = \u201Chello\u201D;',
      replace: 'const msg = "hi";',
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("typographic");
    expect(r.message).toBe('const msg = "hi";\n');
  });

  it("typographic match: Unicode dash + non-breaking space", () => {
    // Source uses ASCII hyphen and a normal space; search has an en-dash and NBSP.
    const original = "range: 1-10 items\n";
    const r = applyEdit(original, {
      search: "range: 1\u201310\u00A0items",
      replace: "range: 1-20 items",
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("typographic");
    expect(r.message).toBe("range: 1-20 items\n");
  });

  it("typographic match: collapses differing inner whitespace", () => {
    const original = "foo   bar    baz\n";
    const r = applyEdit(original, { search: "foo bar baz", replace: "done" });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("typographic");
    expect(r.message).toBe("done\n");
  });

  it("typographic replacement preserves surrounding source bytes", () => {
    // Only the matched block changes; the original curly quote on line 3 stays.
    const original = 'a = "x";\nb = \u201Cy\u201D;\nc = "z";\n';
    const r = applyEdit(original, {
      search: 'a = \u201Cx\u201D;',
      replace: "a = 1;",
    });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("typographic");
    // Line 2's real curly quotes are untouched — we only replaced line 1.
    expect(r.message).toBe('a = 1;\nb = \u201Cy\u201D;\nc = "z";\n');
  });

  it("not found", () => {
    const r = applyEdit("hello", { search: "zzz", replace: "y" });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("none");
    expect(r.message).toMatch(/not found/i);
  });

  it("rejects empty search (does not match a blank line)", () => {
    const r = applyEdit("a\n\nb\n", { search: "", replace: "X" });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("validate");
    expect(r.message).toMatch(/empty/i);
  });

  it("returns invalid regex instead of throwing", () => {
    const r = applyEdit("hello", { search: "(", replace: "x", regex: true });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("regex");
    expect(r.message).toMatch(/invalid regex/i);
  });

  it("includes a closest snippet when search is missing", () => {
    const original = "alpha\nhello world\nomega\n";
    const r = applyEdit(original, { search: "hello wrld", replace: "hi" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/closest match/i);
    expect(r.message).toContain("hello world");
  });

  it("hints when replace text is already present", () => {
    const r = applyEdit("hello there\n", { search: "hello wrld", replace: "hello there" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already be applied/i);
  });

  it("exact edit keeps untouched mixed line endings", () => {
    // Line 1 CRLF, line 2 LF, line 3 CRLF — only middle line changes.
    const original = "keep-a\r\nchange-me\nkeep-c\r\n";
    const r = applyEdit(original, { search: "change-me", replace: "changed" });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("exact");
    expect(r.message).toBe("keep-a\r\nchanged\nkeep-c\r\n");
  });

  it("LF search matches a CRLF file without rewriting other endings", () => {
    const original = "alpha\r\nbeta\r\ngamma\r\n";
    const r = applyEdit(original, {
      search: "alpha\nbeta",
      replace: "alpha\nBETA",
    });
    expect(r.ok).toBe(true);
    expect(r.message.startsWith("alpha\r\nBETA")).toBe(true);
    expect(r.message.endsWith("gamma\r\n") || r.message.includes("gamma\r\n")).toBe(true);
  });
});

describe("editFileTool (integration with disk)", () => {
  it("writes to disk on success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "hello world\n", "utf-8");
    const ctx = {
      cwd: dir,
      signal: undefined,
      async artifact() {
        return "art_x";
      },
      async readArtifact() {
        return "";
      },
    };
    const r = await editFileTool.execute({ path: file, search: "world", replace: "there" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("hello there\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("schema rejects empty search instead of matching a blank line", () => {
    const parsed = editFileTool.inputSchema.safeParse({
      path: "f.txt",
      search: "",
      replace: "X",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects overlapping multi-edits against the original", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "hello world\n", "utf-8");
    const ctx = {
      cwd: dir,
      signal: undefined,
      async artifact() {
        return "art_x";
      },
      async readArtifact() {
        return "";
      },
    };
    const r = await editFileTool.execute(
      {
        path: file,
        edits: [
          { search: "hello world", replace: "A" },
          { search: "world", replace: "B" },
        ],
      },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/overlap/i);
    expect(readFileSync(file, "utf-8")).toBe("hello world\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits one edit_delta per applied edit after a successful multi-edit write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "aaa bbb ccc\n", "utf-8");
    const events: { type: string; index?: number; total?: number }[] = [];
    const ctx = {
      cwd: dir,
      signal: undefined,
      async artifact() {
        return "art_x";
      },
      async readArtifact() {
        return "";
      },
      emitEvent: (e: { type: string; index?: number; total?: number }) => {
        events.push(e);
      },
    };
    const r = await editFileTool.execute(
      {
        path: file,
        edits: [
          { search: "aaa", replace: "A" },
          { search: "bbb", replace: "B" },
          { search: "ccc", replace: "C" },
        ],
      },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("A B C\n");
    const deltas = events.filter((e) => e.type === "edit_delta");
    expect(deltas).toHaveLength(3);
    expect(deltas.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(deltas.every((d) => d.total === 3)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits NO edit_delta when the edit fails (transactional rollback)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "aaa bbb\n", "utf-8");
    const events: { type: string }[] = [];
    const ctx = {
      cwd: dir,
      signal: undefined,
      async artifact() {
        return "art_x";
      },
      async readArtifact() {
        return "";
      },
      emitEvent: (e: { type: string }) => {
        events.push(e);
      },
    };
    const r = await editFileTool.execute(
      {
        path: file,
        edits: [
          { search: "aaa", replace: "A" },
          { search: "NOPE", replace: "X" },
        ],
      },
      ctx,
    );
    expect(r.isError).toBe(true);
    // File untouched, and no deltas streamed for the rolled-back batch.
    expect(readFileSync(file, "utf-8")).toBe("aaa bbb\n");
    expect(events.filter((e) => e.type === "edit_delta")).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns isError on missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-"));
    const ctx = {
      cwd: dir,
      signal: undefined,
      async artifact() {
        return "art_x";
      },
      async readArtifact() {
        return "";
      },
    };
    const r = await editFileTool.execute(
      { path: join(dir, "nope.txt"), search: "x", replace: "y" },
      ctx
    );
    expect(r.isError).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
