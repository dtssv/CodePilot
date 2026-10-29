// write_file append mode: incremental large-file construction.

import { describe, expect, it } from "vitest";
import { writeFileTool } from "../src/tools/write_file.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(dir: string) {
  return {
    cwd: dir,
    signal: undefined,
    async artifact() {
      return "art_x";
    },
    async readArtifact() {
      return "";
    },
  } as never;
}

describe("write_file append mode", () => {
  it("creates a new file when appending to a non-existent path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const file = join(dir, "log.txt");
    const r = await writeFileTool.execute({ path: file, content: "line 1\n", append: true }, ctx(dir));
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("line 1\n");
    expect(r.content).toMatch(/created|append mode/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends to an existing file without overwriting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const file = join(dir, "log.txt");
    await writeFileTool.execute({ path: file, content: "a\n", append: true }, ctx(dir));
    await writeFileTool.execute({ path: file, content: "b\n", append: true }, ctx(dir));
    await writeFileTool.execute({ path: file, content: "c\n", append: true }, ctx(dir));
    expect(readFileSync(file, "utf-8")).toBe("a\nb\nc\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("append does NOT require read-before-write (no freshness guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const file = join(dir, "log.txt");
    // Pre-create the file on disk so it "exists" but was never observed.
    await writeFileTool.execute({ path: file, content: "seed\n", append: true }, ctx(dir));
    // A freshness guard that would block any overwrite of an unobserved file.
    const guardCtx = {
      ...ctx(dir),
      checkFileFresh: () => ({ ok: false, message: "stale: read the file first" }),
    } as never;
    // Appending must bypass the guard (it adds, never replaces).
    const r = await writeFileTool.execute(
      { path: file, content: "more\n", append: true },
      guardCtx,
    );
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("seed\nmore\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("overwrite mode still honours the freshness guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const file = join(dir, "f.txt");
    await writeFileTool.execute({ path: file, content: "v1\n" }, ctx(dir));
    const guardCtx = {
      ...ctx(dir),
      checkFileFresh: () => ({ ok: false, message: "stale: read the file first" }),
    } as never;
    const r = await writeFileTool.execute({ path: file, content: "v2\n" }, guardCtx);
    expect(r.isError).toBe(true);
    // Content unchanged — the blocked overwrite did not land.
    expect(readFileSync(file, "utf-8")).toBe("v1\n");
    expect(existsSync(file)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
