import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droppedFilePaths, renderRestoredFiles } from "../src/compaction/compactionRestore.js";
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

  it("lists paths only — does not paste file bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-restore-"));
    writeFileSync(join(dir, "small.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(dir, "big.ts"), Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i};`).join("\n"));
    writeFileSync(join(dir, "denied.ts"), "secret");
    const paths = ["missing.ts", "denied.ts", "small.ts", "big.ts", "extra.ts"].map((p) => join(dir, p));
    writeFileSync(join(dir, "extra.ts"), "x");

    const { text, files } = await renderRestoredFiles(paths, {
      cwd: dir,
      maxFiles: 2,
      canRead: (p) => !p.endsWith("denied.ts"),
    });
    expect(files.map((f) => f.path)).toEqual([join(dir, "small.ts"), join(dir, "big.ts")]);
    expect(text).toContain("<restored_files>");
    expect(text).toContain(`- \`${join(dir, "small.ts")}\``);
    expect(text).toContain(`- \`${join(dir, "big.ts")}\``);
    expect(text).not.toContain("export const b = 2;");
    expect(text).not.toContain("const v0");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("extra.ts");
    expect(text).toMatch(/re-read with read_file/i);
  });

  it("returns nothing when no path is readable", async () => {
    const { text, files } = await renderRestoredFiles(["/nope/x.ts"], {
      cwd: "/",
      maxFiles: 5,
      canRead: () => false,
    });
    expect(text).toBe("");
    expect(files).toEqual([]);
  });
});
