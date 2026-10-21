import { describe, expect, it } from "vitest";
import {
  DoomLoopDetector,
  MUTATION_BURST_REFUSE,
  MUTATION_BURST_WARN,
  isVerifyLikeCommand,
  mutationPaths,
} from "../src/doomLoop.js";

describe("mutationPaths / isVerifyLikeCommand", () => {
  it("extracts write/edit paths", () => {
    expect(mutationPaths("write_file", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(mutationPaths("edit_file", { path: "./src/a.ts" })).toEqual(["src/a.ts"]);
  });

  it("extracts apply_patch paths", () => {
    const patch =
      "*** Begin Patch\n*** Update File: a.ts\n*** End File\n*** Add File: b.ts\nx\n*** End Patch\n";
    expect(mutationPaths("apply_patch", { patch })).toEqual(["a.ts", "b.ts"]);
  });

  it("recognizes verify-like bash", () => {
    expect(isVerifyLikeCommand("pnpm test")).toBe(true);
    expect(isVerifyLikeCommand("npm run build")).toBe(true);
    expect(isVerifyLikeCommand("ls -la")).toBe(false);
  });
});

describe("DoomLoopDetector mutation burst", () => {
  it("warns then refuses consecutive mutations on the same path without verify", () => {
    const d = new DoomLoopDetector();
    for (let i = 0; i < MUTATION_BURST_WARN - 1; i++) {
      const r = d.check("edit_file", { path: "f.ts", search: `a${i}`, replace: `b${i}` });
      expect(r.refuse).toBe(false);
      expect(r.warn).toBe(false);
    }
    const warn = d.check("edit_file", {
      path: "f.ts",
      search: "warn",
      replace: "x",
    });
    expect(warn.warn).toBe(true);
    expect(warn.refuse).toBe(false);

    for (let i = MUTATION_BURST_WARN; i < MUTATION_BURST_REFUSE - 1; i++) {
      const r = d.check("edit_file", { path: "f.ts", search: `c${i}`, replace: `d${i}` });
      expect(r.refuse).toBe(false);
    }
    const refuse = d.check("edit_file", {
      path: "f.ts",
      search: "refuse",
      replace: "x",
    });
    expect(refuse.refuse).toBe(true);
    expect(refuse.message).toMatch(/verify/i);
  });

  it("resets burst after a verify-like bash", () => {
    const d = new DoomLoopDetector();
    for (let i = 0; i < MUTATION_BURST_WARN; i++) {
      d.check("write_file", { path: "f.ts", content: `v${i}` });
    }
    d.check("bash", { command: "pnpm test" });
    const after = d.check("write_file", { path: "f.ts", content: "ok" });
    expect(after.warn).toBe(false);
    expect(after.refuse).toBe(false);
  });

  it("does not aggregate unrelated paths into the same burst refuse early", () => {
    const d = new DoomLoopDetector();
    for (let i = 0; i < 3; i++) {
      d.check("edit_file", { path: "a.ts", search: `x${i}`, replace: "y" });
    }
    const other = d.check("edit_file", { path: "b.ts", search: "x", replace: "y" });
    expect(other.refuse).toBe(false);
    expect(other.warn).toBe(false);
  });
});
