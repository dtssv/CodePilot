// The change view model derived from file-mutating tool calls.

import { describe, expect, it } from "vitest";

import { fileChangeFromToolCall, isFileMutation } from "../src/state/diff.js";

describe("isFileMutation", () => {
  it("covers the write tools and nothing else", () => {
    for (const t of ["write_file", "edit_file", "apply_patch", "notebook_edit"]) {
      expect(isFileMutation(t)).toBe(true);
    }
    for (const t of ["read_file", "bash", "grep", "task"]) {
      expect(isFileMutation(t)).toBe(false);
    }
  });
});

describe("fileChangeFromToolCall", () => {
  it("renders write_file as an all-additions hunk", () => {
    const change = fileChangeFromToolCall("write_file", {
      path: "src/a.ts",
      content: "line one\nline two",
    })!;
    expect(change.path).toBe("src/a.ts");
    expect(change.operation).toBe("write");
    expect(change.added).toBe(2);
    expect(change.removed).toBe(0);
    expect(change.hunks[0]?.lines.map((l) => l.kind)).toEqual(["add", "add"]);
  });

  it("renders a single search/replace edit as removals then additions", () => {
    const change = fileChangeFromToolCall("edit_file", {
      path: "src/b.ts",
      search: "const a = 1;",
      replace: "const a = 2;\nconst b = 3;",
    })!;
    expect(change.operation).toBe("edit");
    expect(change.removed).toBe(1);
    expect(change.added).toBe(2);
    expect(change.hunks).toHaveLength(1);
    expect(change.hunks[0]?.label).toBeUndefined();
    expect(change.hunks[0]?.lines.map((l) => l.kind)).toEqual([
      "remove",
      "add",
      "add",
    ]);
  });

  it("labels each hunk in multi-edit mode", () => {
    const change = fileChangeFromToolCall("edit_file", {
      path: "src/c.ts",
      edits: [
        { search: "a", replace: "A" },
        { search: "b", replace: "B" },
      ],
    })!;
    expect(change.hunks.map((h) => h.label)).toEqual(["edit 1 of 2", "edit 2 of 2"]);
    expect(change.added).toBe(2);
    expect(change.removed).toBe(2);
  });

  it("flags global and regex edits, which change what the diff means", () => {
    const change = fileChangeFromToolCall("edit_file", {
      path: "src/d.ts",
      search: "foo",
      replace: "bar",
      global_replace: true,
      regex: true,
    })!;
    const meta = change.hunks[0]?.lines.find((l) => l.kind === "meta");
    expect(meta?.text).toBe("every occurrence, regex search");
  });

  it("truncates a huge payload instead of rendering thousands of rows", () => {
    const content = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
    const change = fileChangeFromToolCall("write_file", { path: "big.txt", content })!;
    expect(change.truncated).toBe(true);
    const lines = change.hunks[0]!.lines;
    expect(lines.length).toBeLessThan(450);
    expect(lines[lines.length - 1]).toMatchObject({ kind: "meta" });
    expect(lines[lines.length - 1]?.text).toMatch(/500 more line/);
  });

  it("keeps the path for payloads it does not model", () => {
    const change = fileChangeFromToolCall("apply_patch", { path: "src/e.ts" })!;
    expect(change).toMatchObject({ path: "src/e.ts", operation: "patch", hunks: [] });
    const nb = fileChangeFromToolCall("notebook_edit", { notebook_path: "n.ipynb" })!;
    expect(nb.path).toBe("n.ipynb");
  });

  it("returns null rather than throwing on unusable input", () => {
    expect(fileChangeFromToolCall("bash", { command: "ls" })).toBeNull();
    expect(fileChangeFromToolCall("write_file", null)).toBeNull();
    expect(fileChangeFromToolCall("write_file", { content: "x" })).toBeNull();
    // edit_file with neither `search` nor `edits` cannot be rendered.
    expect(fileChangeFromToolCall("edit_file", { path: "a.ts" })).toBeNull();
  });
});
