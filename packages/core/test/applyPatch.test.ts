import { describe, expect, it } from "vitest";
import { parsePatch, pathsFromApplyPatch } from "../src/tools/apply_patch.js";
import { PermissionEngine } from "../src/permissions.js";
import { applyPatchTool } from "../src/tools/apply_patch.js";
import { resolveSandbox } from "../src/sandbox.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileObservationStore } from "../src/fsObservation.js";
import { readFileTool } from "../src/tools/read_file.js";
import type { ToolContext } from "../src/tools/types.js";

function patchCtx(dir: string, store: FileObservationStore): ToolContext {
  return {
    cwd: dir,
    artifact: async () => "art_test",
    readArtifact: async () => "",
    observeFile: (p, s, h) => store.observe(p, s, h),
    checkFileFresh: (p, s, h) => store.checkFresh(p, s, h),
    reobserveFile: (p, s, h) => store.reobserveAfterWrite(p, s, h),
  } as unknown as ToolContext;
}

const sampleWithoutEndFile = `*** Begin Patch
*** Update File: /Users/zyf/workspace/web/test/src/vehicle.js
@@
   maxReverse: 12,
-  maxLatAcc: 26,           // m/s^2 of cornering grip
+  maxLatAcc: 28,           // m/s^2 of cornering grip
   maxYawRate: 2.35,        // rad/s
*** End Patch`;

const sampleWithEndFile = `*** Begin Patch
*** Update File: a.js
@@
- old
+ new
*** End File
*** Add File: b.js
hello
*** End File
*** End Patch`;

describe("parsePatch", () => {
  it("accepts Update File that omits *** End File before End Patch", () => {
    const ops = parsePatch(sampleWithoutEndFile);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("update");
    expect(ops[0]!.path).toContain("vehicle.js");
    expect(ops[0]!.hunks?.length).toBeGreaterThan(0);
  });

  it("still accepts explicit *** End File markers", () => {
    const ops = parsePatch(sampleWithEndFile);
    expect(ops.map((o) => o.kind)).toEqual(["update", "add"]);
    expect(ops[1]!.content).toBe("hello");
  });

  it("pathsFromApplyPatch reads headers only", () => {
    expect(pathsFromApplyPatch(sampleWithoutEndFile)).toEqual([
      "/Users/zyf/workspace/web/test/src/vehicle.js",
    ]);
    expect(pathsFromApplyPatch(sampleWithEndFile)).toEqual(["a.js", "b.js"]);
  });
});

describe("apply_patch permissions", () => {
  it("auto-allows when every patched path is inside the sandbox", () => {
    const cwd = "/Users/zyf/workspace/web/test";
    const e = new PermissionEngine({ permissionMode: "ask" });
    e.setSandbox(resolveSandbox({ mode: "workspace-write" }, cwd), cwd);
    const patch = `*** Begin Patch
*** Update File: ${cwd}/src/vehicle.js
@@
- a
+ b
*** End Patch`;
    const result = e.preflight(applyPatchTool, { patch });
    expect(result).toEqual({
      decision: "allow",
      reason: "write confined to sandbox writable roots",
    });
  });

  it("asks when a patched path is outside the sandbox", () => {
    const cwd = "/Users/zyf/workspace/web/test";
    const e = new PermissionEngine({ permissionMode: "ask" });
    e.setSandbox(resolveSandbox({ mode: "workspace-write" }, cwd), cwd);
    const patch = `*** Begin Patch
*** Update File: /other/proj/x.js
@@
- a
+ b
*** End Patch`;
    expect(e.preflight(applyPatchTool, { patch })).toBe("ask");
  });
});

describe("apply_patch Add File overwrite guard", () => {
  it("creates a new file via Add File", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-add-"));
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Add File: new.js
+const x = 1;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBeUndefined();
    expect(existsSync(join(dir, "new.js"))).toBe(true);
    expect(readFileSync(join(dir, "new.js"), "utf-8")).toContain("const x = 1;");
  });

  it("refuses to overwrite an existing, unread file via Add File", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-add-"));
    const p = join(dir, "exists.js");
    writeFileSync(p, "const original = true;\n");
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Add File: exists.js
+const clobbered = true;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/already exists/);
    // File untouched.
    expect(readFileSync(p, "utf-8")).toBe("const original = true;\n");
  });

  it("allows Add File to replace a file observed fresh this session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-add-"));
    const p = join(dir, "seen.js");
    writeFileSync(p, "const original = 1;\n");
    const store = new FileObservationStore();
    const ctx = patchCtx(dir, store);
    // Read it first → observed fresh.
    await readFileTool.execute({ path: "seen.js" }, ctx);
    const patch = `*** Begin Patch
*** Add File: seen.js
+const replaced = 2;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/replaced seen\.js/);
    expect(readFileSync(p, "utf-8")).toContain("const replaced = 2;");
  });

  it("update behaviour is unchanged (read-before-write still enforced)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-add-"));
    const p = join(dir, "u.js");
    writeFileSync(p, "a\n");
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Update File: u.js
@@
-a
+b
*** End Patch`;
    // Not read first → update is refused.
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("a\n");
  });
});
