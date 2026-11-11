import { describe, expect, it } from "vitest";

import { parseBlocks } from "../src/ui/Markdown.js";

describe("Markdown fenced-code parsing", () => {
  it("renders a normal closed fence and the markdown that follows it", () => {
    const md = [
      "```bash",
      "echo hi",
      "```",
      "## After",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    const kinds = parseBlocks(md).map((b) => b.kind);
    expect(kinds).toContain("code");
    expect(kinds).toContain("heading");
    expect(kinds).toContain("table");
  });

  it("does not swallow following content when the body contains a ```lang line", () => {
    // The real bug: a code block whose body has an info-bearing fence line
    // must still close at the first BARE closer, so the heading + table after
    // it render as markdown instead of being absorbed into one code block.
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
    // Exactly one code block, and the bare-closer content didn't eat the table.
    const code = blocks.filter((b) => b.kind === "code");
    expect(code).toHaveLength(1);
    expect(code[0]!.text).not.toContain("| a | b |");
  });

  it("treats an info-bearing fence inside the body as content, not a closer", () => {
    const md = ["```bash", "echo hi", "```python", "print(1)", "```"].join("\n");
    const code = parseBlocks(md).filter((b) => b.kind === "code");
    expect(code).toHaveLength(1);
    expect(code[0]!.text).toContain("```python");
  });
});
