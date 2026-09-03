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

  it("trimmed-lines strategy tolerates differing indent", () => {
    const original = "function foo() {\n    return 1;\n}\n";
    const r = applyEdit(original, {
      search: "function foo() {\n  return 1;\n}",
      replace: "function foo() {\n  return 2;\n}",
    });
    expect(r.ok).toBe(true);
    expect(["trimmed-lines", "exact"]).toContain(r.strategy);
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

  it("not found", () => {
    const r = applyEdit("hello", { search: "zzz", replace: "y" });
    expect(r.ok).toBe(false);
    expect(r.strategy).toBe("none");
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
