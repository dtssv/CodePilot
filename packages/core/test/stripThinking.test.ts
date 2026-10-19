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

