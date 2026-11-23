import { describe, expect, it } from "vitest";

import {
  findMentionAtCaret,
  formatComposerRef,
  mergeRefsIntoPrompt,
  newComposerRef,
} from "../src/state/composerRefs.js";

describe("composerRefs", () => {
  it("formats path and range refs", () => {
    expect(formatComposerRef(newComposerRef({ path: "a/b.md" }))).toBe("@a/b.md");
    expect(
      formatComposerRef(newComposerRef({ path: "a.ts", startLine: 3, endLine: 9 })),
    ).toBe("@a.ts:L3-9");
  });

  it("merges chips ahead of free text", () => {
    const refs = [newComposerRef({ path: "aaa.md" })];
    expect(mergeRefsIntoPrompt("hello", refs)).toBe("@aaa.md\n\nhello");
    expect(mergeRefsIntoPrompt("", refs)).toBe("@aaa.md");
  });

  it("backspace deletes a whole @mention token", () => {
    const text = "see @aaa.md please";
    // caret after "aaa.md"
    const caret = text.indexOf(".md") + 3;
    expect(findMentionAtCaret(text, caret, "backspace")).toEqual({
      start: text.indexOf("@"),
      end: caret,
    });
  });

  it("delete removes mention starting at caret", () => {
    const text = "@aaa.md x";
    expect(findMentionAtCaret(text, 0, "delete")).toEqual({ start: 0, end: 7 });
  });
});
