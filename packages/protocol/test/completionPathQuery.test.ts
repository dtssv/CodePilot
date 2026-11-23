import { describe, expect, it } from "vitest";
import { splitCompletionPathQuery } from "../src/server/handlers/workspace.js";

describe("splitCompletionPathQuery", () => {
  it("treats empty / root as scoped browse of cwd", () => {
    expect(splitCompletionPathQuery("")).toEqual({ dirPrefix: "", base: "", scoped: true });
    expect(splitCompletionPathQuery("/")).toEqual({ dirPrefix: "", base: "", scoped: true });
  });

  it("treats a bare fragment as fuzzy (not scoped)", () => {
    expect(splitCompletionPathQuery("package")).toEqual({
      dirPrefix: "",
      base: "package",
      scoped: false,
    });
  });

  it("splits a path prefix for directory-scoped listing", () => {
    expect(splitCompletionPathQuery("pkg/")).toEqual({
      dirPrefix: "pkg/",
      base: "",
      scoped: true,
    });
    expect(splitCompletionPathQuery("pkg/a")).toEqual({
      dirPrefix: "pkg/",
      base: "a",
      scoped: true,
    });
    expect(splitCompletionPathQuery("a/b/c.ts")).toEqual({
      dirPrefix: "a/b/",
      base: "c.ts",
      scoped: true,
    });
  });
});
