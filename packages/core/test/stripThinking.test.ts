import { describe, expect, it } from "vitest";
import { hasVisibleAssistantContent, splitThinking, stripThinking, stripGoalStatus, type ThinkingSegment } from "../src/stripThinking.js";

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

describe("stripGoalStatus", () => {
  it("removes the completed marker and its surrounding whitespace", () => {
    expect(stripGoalStatus("Done.\n\n<goal_status>completed</goal_status>")).toBe("Done.");
    expect(stripGoalStatus("<goal_status>completed</goal_status>")).toBe("");
  });

  it("removes blocked marker and reason block", () => {
    const raw =
      "Can't proceed.\n<goal_status>blocked</goal_status>\n<goal_blocked_reason>GH_TOKEN not set</goal_blocked_reason>";
    expect(stripGoalStatus(raw)).toBe("Can't proceed.");
  });

  it("removes a completed-summary block", () => {
    const raw =
      "All green.\n<goal_completed_summary>migrated auth + tests pass</goal_completed_summary>\n<goal_status>completed</goal_status>";
    expect(stripGoalStatus(raw)).toBe("All green.");
  });

  it("drops orphan goal tags left mid-stream", () => {
    expect(stripGoalStatus("working…\n<goal_status>")).toBe("working…");
    expect(stripGoalStatus("</goal_status>\nnext")).toBe("next");
  });

  it("is a no-op on text without goal markers", () => {
    expect(stripGoalStatus("plain answer")).toBe("plain answer");
    expect(stripGoalStatus("")).toBe("");
  });
});

describe("goal markers never surface in rendered output", () => {
  it("stripThinking removes goal markers even without think tags", () => {
    expect(stripThinking("Finished.\n<goal_status>completed</goal_status>")).toBe("Finished.");
  });

  it("splitThinking drops goal markers from its text segments", () => {
    const segs = splitThinking("The result.\n<goal_status>completed</goal_status>");
    expect(segs).toEqual([{ kind: "text", text: "The result." }]);
  });

  it("hasVisibleAssistantContent is false for a goal-marker-only message", () => {
    expect(hasVisibleAssistantContent("<goal_status>completed</goal_status>")).toBe(false);
  });
});

describe("unclosed think on a final turn is not a stuck 'Thinking…'", () => {
  const raw = "<think>\nreasoning that never closed\nand then the real answer";

  it("while streaming, a trailing open think stays incomplete", () => {
    const segs = splitThinking(raw);
    const think = segs.find((s) => s.kind === "think");
    expect(think).toBeDefined();
    expect((think as Extract<ThinkingSegment, { kind: "think" }>).incomplete).toBe(true);
  });

  it("on a final turn, the same open think becomes a completed Thought", () => {
    const segs = splitThinking(raw, { final: true });
    const think = segs.find((s) => s.kind === "think");
    expect(think).toBeDefined();
    // Not incomplete → renders as "Thought", collapsible, never a stuck spinner.
    expect((think as Extract<ThinkingSegment, { kind: "think" }>).incomplete).toBeUndefined();
  });

  it("properly-closed think is unaffected by final", () => {
    const closed = "<think>\nreasoning\n</think>\nthe answer";
    const streamed = splitThinking(closed);
    const fin = splitThinking(closed, { final: true });
    expect(streamed).toEqual(fin);
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

