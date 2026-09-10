import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFilesForCompletion } from "../src/ui/fileComplete.js";

describe("listFilesForCompletion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fc-"));
    // Build a small fixture:
    //   dir/
    //     package.json
    //     src/
    //       index.ts
    //       app.tsx
    //       utils/
    //         helpers.ts
    //     node_modules/  (should be ignored)
    //       foo/index.js
    //     .git/  (should be ignored)
    //       HEAD
    //     dist/  (should be ignored)
    //       bundle.js
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "src", "app.tsx"), "");
    mkdirSync(join(dir, "src", "utils"));
    writeFileSync(join(dir, "src", "utils", "helpers.ts"), "");
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "node_modules", "foo"));
    writeFileSync(join(dir, "node_modules", "foo", "index.js"), "");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "bundle.js"), "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists top-level entries with directories suffixed by /", () => {
    const out = listFilesForCompletion(dir, "");
    expect(out).toContain("package.json");
    expect(out).toContain("src/");
    // ignored dirs must not appear
    expect(out.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(out.some((p) => p.startsWith(".git"))).toBe(false);
    expect(out.some((p) => p.startsWith("dist"))).toBe(false);
  });

  it("filters by prefix", () => {
    const out = listFilesForCompletion(dir, "p");
    expect(out).toEqual(["package.json"]);
  });

  it("descends into a directory given a path prefix", () => {
    const out = listFilesForCompletion(dir, "src/");
    expect(out).toContain("src/index.ts");
    expect(out).toContain("src/app.tsx");
    expect(out).toContain("src/utils/");
    // No noise from outside the prefix.
    expect(out.some((p) => p.startsWith("package"))).toBe(false);
  });

  it("descends further when the prefix is deeper", () => {
    const out = listFilesForCompletion(dir, "src/utils/");
    expect(out).toEqual(["src/utils/helpers.ts"]);
  });

  it("respects the max option", () => {
    const out = listFilesForCompletion(dir, "", { max: 1 });
    expect(out.length).toBe(1);
  });

  it("returns directories first then files", () => {
    const out = listFilesForCompletion(dir, "");
    const firstDirIdx = out.findIndex((p) => p.endsWith("/"));
    const firstFileIdx = out.findIndex((p) => !p.endsWith("/"));
    expect(firstDirIdx).toBeGreaterThanOrEqual(0);
    expect(firstFileIdx).toBeGreaterThan(firstDirIdx);
  });

  it("returns an empty array when nothing matches", () => {
    const out = listFilesForCompletion(dir, "does-not-exist");
    expect(out).toEqual([]);
  });

  it("does not throw when the start directory does not exist", () => {
    const out = listFilesForCompletion(dir, "no-such-dir/");
    expect(out).toEqual([]);
  });
});
