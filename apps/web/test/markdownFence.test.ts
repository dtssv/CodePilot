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
});
