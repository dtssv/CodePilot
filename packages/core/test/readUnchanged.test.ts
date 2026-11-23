// read_file unchanged stub: same path+window while mtime/size still match.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readFileTool, FILE_UNCHANGED_STUB } from "../src/tools/read_file.js";
import { FileObservationStore } from "../src/workspace/fsObservation.js";
import { resolveSandbox } from "../src/sandbox/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

describe("read_file unchanged stub", () => {
  let dir: string;
  let store: FileObservationStore;

  function ctx(): ToolContext {
    return {
      cwd: dir,
      artifact: async () => "art_x",
      readArtifact: async () => "",
      sandbox: resolveSandbox({ mode: "off" }, dir),
      observeFile: (p, s, h, w) => store.observe(p, s, h, w),
      isUnchangedRead: (p, w, s) => store.isUnchangedRead(p, w, s),
      checkFileFresh: (p, s, h, opts) => store.checkFresh(p, s, h, opts),
      reobserveFile: (p, s, h) => store.reobserveAfterWrite(p, s, h),
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cp-read-unchanged-"));
    store = new FileObservationStore();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns full content on first read, then a stub for the same window", async () => {
    await writeFile(join(dir, "a.ts"), "line1\nline2\nline3\n");
    const first = await readFileTool.execute({ path: "a.ts" }, ctx());
    expect(first.content).toContain("line1");
    expect(first.content).not.toContain(FILE_UNCHANGED_STUB);

    const second = await readFileTool.execute({ path: "a.ts" }, ctx());
    expect(second.content).toContain(FILE_UNCHANGED_STUB);
    expect(second.content).not.toContain("1→");
  });

  it("re-reads when the line window changes", async () => {
    await writeFile(join(dir, "a.ts"), "a\nb\nc\nd\n");
    await readFileTool.execute({ path: "a.ts", startLine: 0, maxLines: 2 }, ctx());
    const other = await readFileTool.execute(
      { path: "a.ts", startLine: 2, maxLines: 2 },
      ctx(),
    );
    expect(other.content).not.toContain(FILE_UNCHANGED_STUB);
    expect(other.content).toMatch(/c/);
  });

  it("re-reads after the file changes on disk", async () => {
    const path = join(dir, "a.ts");
    await writeFile(path, "v1\n");
    await readFileTool.execute({ path: "a.ts" }, ctx());
    await writeFile(path, "v2-changed\n");
    // Ensure mtime advances on coarse filesystems.
    const now = new Date(Date.now() + 2000);
    await utimes(path, now, now);
    const again = await readFileTool.execute({ path: "a.ts" }, ctx());
    expect(again.content).not.toContain(FILE_UNCHANGED_STUB);
    expect(again.content).toContain("v2-changed");
  });
});
