import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hasEmbeddedWeb, materializeEmbeddedWeb } from "../src/web-embed.js";

describe("web-embed (source build)", () => {
  it("reports no embedded web and materializes nothing", () => {
    // The committed generated module is empty; only the packaged binary has a
    // populated VFS (via the gen-web-vfs.mjs step).
    expect(hasEmbeddedWeb()).toBe(false);
    expect(materializeEmbeddedWeb()).toBeUndefined();
  });
});

// A standalone copy of the materialize logic exercising the real file I/O used
// by the runtime, so the regression (cpSync cannot read Bun's virtual FS; use
// readFileSync/writeFileSync) stays covered against accidental reintroduction.
function materialize(vfs: Record<string, string>): string | undefined {
  const entries = Object.entries(vfs);
  if (entries.length === 0) return undefined;
  const root = mkdtempSync(join(tmpdir(), "codepilot-web-test-"));
  for (const [rel, src] of entries) {
    const dest = join(root, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, readFileSync(src));
  }
  return existsSync(join(root, "index.html")) ? root : undefined;
}

describe("materialize VFS to a temp directory", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("copies files (including nested paths) and returns the root when index.html is present", () => {
    const srcDir = mkdtempSync(join(tmpdir(), "codepilot-web-src-"));
    scratch.push(srcDir);
    writeFileSync(join(srcDir, "index.html"), "<html>root</html>");
    mkdirSync(join(srcDir, "assets"), { recursive: true });
    writeFileSync(join(srcDir, "assets", "app.js"), "console.log(1)");

    const vfs = {
      "index.html": join(srcDir, "index.html"),
      "assets/app.js": join(srcDir, "assets", "app.js"),
    };
    const root = materialize(vfs);
    expect(root).toBeDefined();
    scratch.push(root!);
    expect(readFileSync(join(root!, "index.html"), "utf8")).toBe("<html>root</html>");
    expect(readFileSync(join(root!, "assets", "app.js"), "utf8")).toBe("console.log(1)");
  });

  it("returns undefined for an empty VFS", () => {
    expect(materialize({})).toBeUndefined();
  });

  it("returns undefined when index.html is missing", () => {
    const srcDir = mkdtempSync(join(tmpdir(), "codepilot-web-src-"));
    scratch.push(srcDir);
    writeFileSync(join(srcDir, "other.txt"), "x");
    const root = materialize({ "other.txt": join(srcDir, "other.txt") });
    expect(root).toBeUndefined();
  });
});
