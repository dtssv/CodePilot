import { describe, expect, it } from "vitest";

import { looksLikeWorkspacePath, parseReference, previewKind } from "../src/state/paths.js";

describe("looksLikeWorkspacePath", () => {
  it("accepts relative files with extensions", () => {
    expect(looksLikeWorkspacePath("docs/design.md")).toBe(true);
    expect(looksLikeWorkspacePath("src/App.tsx")).toBe(true);
  });

  it("accepts file:line cites (grep / model form)", () => {
    expect(looksLikeWorkspacePath("test/mcpSandbox.test.ts:79")).toBe(true);
    expect(looksLikeWorkspacePath("mcpSandbox.test.ts:79")).toBe(true);
  });

  it("rejects urls and flags", () => {
    expect(looksLikeWorkspacePath("https://example.com/a.md")).toBe(false);
    expect(looksLikeWorkspacePath("--verbose")).toBe(false);
    expect(looksLikeWorkspacePath("plainword")).toBe(false);
  });
});

describe("parseReference", () => {
  it("strips a trailing line anchor before open/preview", () => {
    expect(parseReference("test/mcpSandbox.test.ts:79")).toEqual({
      path: "test/mcpSandbox.test.ts",
      line: 79,
    });
  });
});

describe("previewKind", () => {
  it("classifies common deliverables", () => {
    expect(previewKind("design.md")).toBe("markdown");
    expect(previewKind("shot.png")).toBe("image");
    expect(previewKind("main.ts")).toBe("code");
    expect(previewKind("notes")).toBe("text");
  });

  it("classifies code even when a :line anchor is present", () => {
    expect(previewKind("main.ts:42")).toBe("code");
  });
});
