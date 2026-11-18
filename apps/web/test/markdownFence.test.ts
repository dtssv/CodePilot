import { describe, expect, it } from "vitest";

import { parseBlocks } from "../src/components/Markdown.js";

describe("web Markdown fenced-code parsing", () => {
  it("renders a normal closed fence and the markdown that follows it", () => {
    const md = ["```bash", "echo hi", "```", "## After", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const kinds = parseBlocks(md).map((b) => b.kind);
    expect(kinds).toContain("code");
    expect(kinds).toContain("heading");
    expect(kinds).toContain("table");
  });

  it("does not swallow following content when the body contains a ```lang line", () => {
    const md = [
      "```bash",
      "echo hi",
      "```python",
      "print(1)",
      "```",
      "## After",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    const blocks = parseBlocks(md);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("table");
    const code = blocks.filter((b) => b.kind === "code");
    expect(code).toHaveLength(1);
  });

  it("does not merge numbered section headers with following dash bullets", () => {
    const md = [
      "1. USER REQUESTS",
      "- fix the bug",
      "2. CURRENT STATE",
      "- done: a",
    ].join("\n");
    const blocks = parseBlocks(md);
    expect(blocks.map((b) => b.kind)).toEqual(["list", "list", "list", "list"]);
    const lists = blocks.filter((b) => b.kind === "list");
    expect(lists[0]).toMatchObject({ ordered: true, start: 1, items: [{ text: "USER REQUESTS" }] });
    expect(lists[1]).toMatchObject({ ordered: false, items: [{ text: "fix the bug" }] });
    expect(lists[2]).toMatchObject({ ordered: true, start: 2, items: [{ text: "CURRENT STATE" }] });
    expect(lists[3]).toMatchObject({ ordered: false, items: [{ text: "done: a" }] });
  });
});
