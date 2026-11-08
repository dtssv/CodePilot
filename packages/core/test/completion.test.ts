import { describe, expect, it } from "vitest";
import {
  decideCompletionModel,
  buildCompletionPrompt,
  cleanCompletion,
  COMPLETION_SYSTEM_PROMPT,
  COMPLETION_MAX_LINES,
} from "../src/completion.js";

describe("decideCompletionModel", () => {
  it("runs on the small model when it is distinct from the main model", () => {
    const d = decideCompletionModel({ mainModel: "big", smallModel: "small" });
    expect(d).toEqual({ run: true, model: "small" });
  });

  it("refuses when the small model equals the main model (the gate)", () => {
    const d = decideCompletionModel({ mainModel: "big", smallModel: "big" });
    expect(d).toEqual({ run: false, disabledReason: "no-small-model" });
  });

  it("refuses when there is no small model at all", () => {
    const d = decideCompletionModel({ mainModel: "big", smallModel: "" });
    expect(d).toEqual({ run: false, disabledReason: "no-small-model" });
  });

  it("honors an explicit completion model override, even if it equals main", () => {
    const d = decideCompletionModel({ mainModel: "big", smallModel: "big", completionModel: "big" });
    expect(d).toEqual({ run: true, model: "big" });
  });

  it("override wins over a distinct small model", () => {
    const d = decideCompletionModel({ mainModel: "big", smallModel: "small", completionModel: "coder" });
    expect(d).toEqual({ run: true, model: "coder" });
  });
});

describe("buildCompletionPrompt", () => {
  it("frames prefix/suffix with cursor markers and the file basename", () => {
    const p = buildCompletionPrompt({ prefix: "const a = ", suffix: ";\n", path: "src/foo/bar.ts" });
    expect(p).toContain("File: bar.ts");
    expect(p).toContain("<|before|>const a = <|cursor|>;\n<|after|>");
  });

  it("is scenario-neutral — no hardcoded language or framework", () => {
    const p = buildCompletionPrompt({ prefix: "x", suffix: "y", path: "a.py" });
    expect(COMPLETION_SYSTEM_PROMPT).not.toMatch(/python|typescript|react|framework/i);
    expect(p).not.toMatch(/python|typescript|react/i);
  });

  it("handles a bare filename and backslash paths", () => {
    expect(buildCompletionPrompt({ prefix: "", suffix: "", path: "file.go" })).toContain("File: file.go");
    expect(buildCompletionPrompt({ prefix: "", suffix: "", path: "a\\b\\c.rs" })).toContain("File: c.rs");
  });
});

describe("cleanCompletion", () => {
  it("returns empty for whitespace-only output", () => {
    expect(cleanCompletion("   \n  ", "")).toBe("");
  });

  it("strips a wrapping markdown fence", () => {
    expect(cleanCompletion("```ts\nfoo()\n```", "")).toBe("foo()");
  });

  it("drops a single leading newline the model prepends", () => {
    expect(cleanCompletion("\nfoo()", "")).toBe("foo()");
  });

  it("stops at the first blank-line run (small block)", () => {
    const raw = "a()\nb()\n\nc()";
    expect(cleanCompletion(raw, "")).toBe("a()\nb()");
  });

  it("keeps a small indented block then stops when indentation closes", () => {
    const prefix = "  if (x) {\n";
    const raw = "    doThing();\n    doOther();\n  }\nafterBlock();";
    const out = cleanCompletion(raw, prefix);
    // No blank line, under the line cap → the whole contiguous block is kept.
    expect(out).toBe("    doThing();\n    doOther();\n  }\nafterBlock();");
  });

  it("caps at COMPLETION_MAX_LINES lines (small block ceiling)", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `line${i}()`).join("\n");
    const out = cleanCompletion(raw, "");
    expect(out.split("\n")).toHaveLength(COMPLETION_MAX_LINES);
    expect(out.split("\n")[0]).toBe("line0()");
  });

  it("trims trailing whitespace", () => {
    expect(cleanCompletion("foo()   \n", "")).toBe("foo()");
  });
});
