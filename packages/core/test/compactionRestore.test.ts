import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droppedFilePaths, renderRestoredFiles } from "../src/compaction/compactionRestore.js";
import { estimateTokens } from "../src/compaction/tokens.js";
import type { Event } from "../src/types.js";

const call = (name: string, path: string, id = path): Event =>
  ({ type: "tool_call", id: `${name}:${id}`, name, input: { path } }) as Event;

describe("compactionRestore", () => {
  it("picks dropped file paths most-recent-first, skipping ones still visible", () => {
    const cwd = "/w";
    const dropped = [call("read_file", "a.ts"), call("read_file", "b.ts"), call("edit_file", "a.ts", "2"), call("bash", "x"), call("read_file", "c.ts")];
    const retained = [call("read_file", "/w/c.ts", "r")];
    expect(droppedFilePaths(dropped, retained, cwd)).toEqual(["/w/a.ts", "/w/b.ts"]);
  });

  it("restores current content within file-count and token budgets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-restore-"));
    writeFileSync(join(dir, "small.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(dir, "big.ts"), Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i};`).join("\n"));
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, "denied.ts"), "secret");
    const paths = ["missing.ts", "bin.dat", "denied.ts", "small.ts", "big.ts", "extra.ts"].map((p) => join(dir, p));
    writeFileSync(join(dir, "extra.ts"), "x");

    const { text, files } = await renderRestoredFiles(paths, {
      cwd: dir,
      maxFiles: 2,
      perFileTokens: 200,
      totalTokens: 10_000,
      estimateTokens,
      canRead: (p) => !p.endsWith("denied.ts"),
    });
    expect(files.map((f) => f.path)).toEqual([join(dir, "small.ts"), join(dir, "big.ts")]);
    expect(text).toContain("<restored_files>");
    expect(text).toContain("export const b = 2;");
    expect(text).toMatch(/big\.ts \(\d+ of 2000 lines; read_file with startLine=\d+ for the rest\)/);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("extra.ts");
    expect(estimateTokens(text)).toBeLessThan(600);
  });

  it("returns nothing when no file fits", async () => {
    const { text, files } = await renderRestoredFiles(["/nope/x.ts"], {
      cwd: "/", maxFiles: 5, perFileTokens: 100, totalTokens: 100, estimateTokens, canRead: () => true,
    });
    expect(text).toBe("");
    expect(files).toEqual([]);
  });
});
