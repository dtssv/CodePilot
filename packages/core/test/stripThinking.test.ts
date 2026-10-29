import { describe, expect, it } from "vitest";
import { hasVisibleAssistantContent, splitThinking, stripThinking } from "../src/stripThinking.js";

describe("stripThinking", () => {
  it("removes closed think blocks and keeps the answer", () => {
    const raw =
      "<think>\nThe file has 3 rows.\nI should be direct.\n</think>\n\n平均薪资是 14000。";
    expect(stripThinking(raw)).toBe("平均薪资是 14000。");
  });

  it("hides an unfinished think block while streaming", () => {
    expect(stripThinking("<think>\nstill reasoning")).toBe("");
    expect(stripThinking("前置\n<think>\nstill")).toBe("前置");
  });

  it("leaves ordinary text alone", () => {
    expect(stripThinking("hello <code>x</code>")).toBe("hello <code>x</code>");
  });

  it("drops orphan closing / opening tags (GLM / DeepSeek leak)", () => {
    expect(stripThinking("</think>\n\n答案是 42")).toBe("答案是 42");
    expect(stripThinking("<think>\n</think>\n可见答案")).toBe("可见答案");
    expect(stripThinking("前言</think>\n正文")).toBe("前言\n正文");
  });
});

describe("splitThinking", () => {
  it("separates think bodies from the answer", () => {
    const segs = splitThinking(
      "<think>\n先推理\n</think>\n\n最终答案",
    );
    expect(segs).toEqual([
      { kind: "think", text: "先推理" },
      { kind: "text", text: "\n\n最终答案" },
    ]);
  });

  it("marks an unclosed think as incomplete", () => {
    const segs = splitThinking("<think>\nstill going");
    expect(segs).toEqual([{ kind: "think", text: "\nstill going", incomplete: true }]);
  });

  it("returns plain text unchanged", () => {
    expect(splitThinking("hello")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("treats <think> inside inline code as text, not a reasoning stream", () => {
    const raw = "See `stripThinking.ts` — it splits `<think>` / `<thinking>` bodies.";
    expect(splitThinking(raw)).toEqual([{ kind: "text", text: raw }]);
    expect(hasVisibleAssistantContent(raw)).toBe(true);
    // Nothing folded away: stripThinking keeps the whole line.
    expect(stripThinking(raw)).toBe(raw);
  });

  it("treats <think> inside a fenced code block as text", () => {
    const raw = "Example:\n\n```ts\nconst x = `<think>${y}</think>`;\n```\n\ndone";
    const segs = splitThinking(raw);
    expect(segs.every((s) => s.kind === "text")).toBe(true);
    expect(segs.map((s) => s.text).join("")).toContain("<think>${y}</think>");
  });

  it("still folds a real think block that precedes a code answer", () => {
    const raw = "<think>\nplan it\n</think>\n\nHere:\n```ts\nconst a = 1;\n```";
    const segs = splitThinking(raw);
    expect(segs[0]).toEqual({ kind: "think", text: "plan it" });
    expect(segs[1]?.kind).toBe("text");
    expect(segs[1]?.text).toContain("const a = 1;");
  });

  it("preserves code inside a real think body", () => {
    // A genuine reasoning block that itself contains a code fence must keep
    // its body verbatim (masking is for detection only).
    const raw = "<think>\ntry `const n = 1;`\n</think>\nanswer";
    const segs = splitThinking(raw);
    expect(segs[0]).toEqual({ kind: "think", text: "try `const n = 1;`" });
    expect(segs[1]).toEqual({ kind: "text", text: "\nanswer" });
  });
});

describe("hasVisibleAssistantContent", () => {
  it("is false for empty, orphan tags, and empty think wrappers", () => {
    expect(hasVisibleAssistantContent("")).toBe(false);
    expect(hasVisibleAssistantContent("  \n")).toBe(false);
    expect(hasVisibleAssistantContent("</think>")).toBe(false);
    expect(hasVisibleAssistantContent("<think>\n</think>")).toBe(false);
  });

  it("is true for answers and non-empty think bodies", () => {
    expect(hasVisibleAssistantContent("你好")).toBe(true);
    expect(hasVisibleAssistantContent("<think>推理</think>\n答案")).toBe(true);
    expect(hasVisibleAssistantContent("<think>只有推理</think>")).toBe(true);
    expect(hasVisibleAssistantContent("<think>\nstreaming")).toBe(true);
  });
});

