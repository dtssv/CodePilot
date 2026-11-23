import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPathLock, withWriteLocks, __resetWriteLocksForTests } from "../src/tools/writeLock.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { readFileTool } from "../src/tools/read_file.js";
import type { ToolContext } from "../src/tools/types.js";
import { FileObservationStore } from "../src/workspace/fsObservation.js";

beforeEach(() => {
  __resetWriteLocksForTests();
});

describe("writeLock", () => {
  it("serializes concurrent critical sections on the same path", async () => {
    const order: number[] = [];
    const a = withPathLock("/tmp/lock-a", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    });
    const b = withPathLock("/tmp/lock-a", async () => {
      order.push(3);
      order.push(4);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("allows different paths to run concurrently", async () => {
    let bothEntered = false;
    let aInside = false;
    let bInside = false;
    const a = withPathLock("/tmp/lock-x", async () => {
      aInside = true;
      await new Promise((r) => setTimeout(r, 20));
      if (bInside) bothEntered = true;
      aInside = false;
    });
    const b = withPathLock("/tmp/lock-y", async () => {
      bInside = true;
      await new Promise((r) => setTimeout(r, 20));
      if (aInside) bothEntered = true;
      bInside = false;
    });
    await Promise.all([a, b]);
    expect(bothEntered).toBe(true);
  });

  it("withWriteLocks acquires sorted keys without deadlock", async () => {
    const log: string[] = [];
    await Promise.all([
      withWriteLocks(["/tmp/z", "/tmp/a"], async () => {
        log.push("za");
      }),
      withWriteLocks(["/tmp/a", "/tmp/z"], async () => {
        log.push("az");
      }),
    ]);
    expect(log).toHaveLength(2);
  });

  it("edit_file under lock keeps parallel edits from clobbering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-wlock-"));
    const p = join(dir, "f.txt");
    writeFileSync(p, "alpha\nbeta\n", "utf-8");
    const store = new FileObservationStore();
    const ctx = {
      cwd: dir,
      artifact: async () => "art",
      readArtifact: async () => "",
      observeFile: (path, s, h, w) => store.observe(path, s, h, w),
      isUnchangedRead: (path, w, s) => store.isUnchangedRead(path, w, s),
      checkFileFresh: (path, s, h, opts) => store.checkFresh(path, s, h, opts),
      reobserveFile: (path, s, h) => store.reobserveAfterWrite(path, s, h),
    } as ToolContext;
    await readFileTool.execute({ path: "f.txt" }, ctx);
    const r1 = editFileTool.execute({ path: "f.txt", search: "alpha", replace: "ALPHA" }, ctx);
    const r2 = editFileTool.execute({ path: "f.txt", search: "beta", replace: "BETA" }, ctx);
    const results = await Promise.all([r1, r2]);
    // Both should succeed under serialization (second sees first's write).
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("ALPHA\nBETA\n");
  });
});
