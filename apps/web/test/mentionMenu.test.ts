import { describe, expect, it } from "vitest";
import { applyPick, detectTrigger } from "../src/components/MentionMenu.js";

describe("detectTrigger @file path browse", () => {
  it("keeps atKind=file when the query is a path prefix", () => {
    const text = "@file:pkg/";
    const t = detectTrigger(text, text.length);
    expect(t).toMatchObject({ kind: "at", atKind: "file", query: "pkg/", start: 0 });
  });

  it("applyPick for a dir drill-in replaces the whole trigger", () => {
    const text = "@file:";
    const trigger = detectTrigger(text, text.length)!;
    const next = applyPick(text, trigger, "@file:pkg/");
    expect(next.text).toBe("@file:pkg/");
    expect(detectTrigger(next.text, next.caret)?.query).toBe("pkg/");
  });
});
