import { describe, expect, it } from "vitest";
import { parsePatch, pathsFromApplyPatch } from "../src/tools/apply_patch.js";
import { PermissionEngine } from "../src/permissions.js";
import { applyPatchTool } from "../src/tools/apply_patch.js";
import { resolveSandbox } from "../src/sandbox.js";

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
