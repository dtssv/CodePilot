import { describe, expect, it } from "vitest";

import { looksLikeWorkspacePath, previewKind } from "../src/state/paths.js";

describe("looksLikeWorkspacePath", () => {
  it("accepts relative files with extensions", () => {
    expect(looksLikeWorkspacePath("docs/design.md")).toBe(true);
    expect(looksLikeWorkspacePath("src/App.tsx")).toBe(true);
  });

  it("rejects urls and flags", () => {
    expect(looksLikeWorkspacePath("https://example.com/a.md")).toBe(false);
    expect(looksLikeWorkspacePath("--verbose")).toBe(false);
    expect(looksLikeWorkspacePath("plainword")).toBe(false);
  });
});

describe("previewKind", () => {
  it("classifies common deliverables", () => {
    expect(previewKind("design.md")).toBe("markdown");
    expect(previewKind("shot.png")).toBe("image");
    expect(previewKind("main.ts")).toBe("code");
    expect(previewKind("notes")).toBe("text");
  });
});
