import { describe, expect, it } from "vitest";

import { parseBlocks, normalizeSectionNumbers } from "../src/components/Markdown.js";

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

  it("restarts ordered-list and bold-number display under each heading", () => {
    const md = [
      "## P0",
      "1. first",
      "2. second",
      "## P1",
      "7. seventh",
      "",
      "**8. bold eight**",
      "",
      "**9. bold nine**",
    ].join("\n");
    const blocks = parseBlocks(md);
    const lists = blocks.filter((b) => b.kind === "list");
    expect(lists[0]).toMatchObject({ ordered: true, start: 1, items: [{ text: "first" }, { text: "second" }] });
    expect(lists[1]).toMatchObject({ ordered: true, start: 1, items: [{ text: "seventh" }] });
    const paras = blocks.filter((b) => b.kind === "para");
    expect(paras.map((p) => (p.kind === "para" ? p.text : ""))).toEqual([
      "**1. bold eight**",
      "**2. bold nine**",
    ]);
  });

  it("leaves source numbering alone when there is no heading", () => {
    const blocks = normalizeSectionNumbers([
      { kind: "list", ordered: true, start: 7, items: [{ text: "keep" }] },
      { kind: "para", text: "**8. also keep**" },
    ]);
    expect(blocks[0]).toMatchObject({ start: 7 });
    expect(blocks[1]).toMatchObject({ text: "**8. also keep**" });
  });
});
