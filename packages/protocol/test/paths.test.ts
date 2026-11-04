import { describe, it, expect } from "vitest";
import { parseReference, looksLikeWorkspacePath } from "../src/paths.js";

describe("parseReference", () => {
  it("splits a path with a line anchor (grep's file:line form)", () => {
    expect(parseReference("src/foo.ts:42")).toEqual({ path: "src/foo.ts", line: 42 });
  });

  it("splits a path with line:column", () => {
    expect(parseReference("src/foo.ts:42:7")).toEqual({ path: "src/foo.ts", line: 42, column: 7 });
  });

  it("strips the anchor from a bare filename with an extension", () => {
    expect(parseReference("foo.ts:42")).toEqual({ path: "foo.ts", line: 42 });
  });

  it("leaves a path with no anchor untouched", () => {
    expect(parseReference("src/foo.ts")).toEqual({ path: "src/foo.ts" });
    expect(parseReference("src/dir")).toEqual({ path: "src/dir" });
  });

  it("does not mis-split a non-path host:port", () => {
    expect(parseReference("localhost:8080")).toEqual({ path: "localhost:8080" });
  });

  it("does not mis-split a bare line:col with no path head", () => {
    expect(parseReference("12:34")).toEqual({ path: "12:34" });
  });

  it("ignores a non-positive or absurd line number as an anchor-less path", () => {
    // `:0` is not a valid 1-based line → head still path-like, line dropped.
    expect(parseReference("foo.ts:0")).toEqual({ path: "foo.ts" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseReference("  src/foo.ts:42  ")).toEqual({ path: "src/foo.ts", line: 42 });
  });
});

describe("looksLikeWorkspacePath", () => {
  it("accepts a relative path with an extension", () => {
    expect(looksLikeWorkspacePath("src/foo.ts")).toBe(true);
  });

  it("accepts grep's file:line output (bare and with dir)", () => {
    expect(looksLikeWorkspacePath("src/foo.ts:42")).toBe(true);
    expect(looksLikeWorkspacePath("foo.ts:42")).toBe(true);
  });

  it("accepts a bare filename with an extension", () => {
    expect(looksLikeWorkspacePath("README.md")).toBe(true);
  });

  it("rejects urls and schemes", () => {
    expect(looksLikeWorkspacePath("https://example.com")).toBe(false);
    expect(looksLikeWorkspacePath("mailto:a@b.com")).toBe(false);
  });

  it("rejects flags, whitespace, and non-path tokens", () => {
    expect(looksLikeWorkspacePath("--force")).toBe(false);
    expect(looksLikeWorkspacePath("hello world")).toBe(false);
    expect(looksLikeWorkspacePath("localhost:8080")).toBe(false);
  });
});
