import { describe, expect, it } from "vitest";
import { parsePatch, pathsFromApplyPatch, applyHunk, applyPatchTool } from "../src/tools/apply_patch.js";
import { PermissionEngine } from "../src/permissions/permissions.js";
import { resolveSandbox } from "../src/sandbox/sandbox.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileObservationStore } from "../src/workspace/fsObservation.js";
import { readFileTool } from "../src/tools/read_file.js";
import type { ToolContext } from "../src/tools/types.js";

function patchCtx(dir: string, store: FileObservationStore): ToolContext {
  return {
    cwd: dir,
    artifact: async () => "art_test",
    readArtifact: async () => "",
    observeFile: (p, s, h) => store.observe(p, s, h),
    checkFileFresh: (p, s, h, opts) => store.checkFresh(p, s, h, opts),
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

  it("parses Move to and @@ change_context / End of File", () => {
    const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@ class Foo
-  a
+  b
*** End of File
-  z
+  Z
*** End Patch`;
    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("update");
    expect(ops[0]!.path).toBe("old.ts");
    expect(ops[0]!.moveTo).toBe("new.ts");
    expect(ops[0]!.hunks).toHaveLength(2);
    expect(ops[0]!.hunks![0]!.changeContext).toBe("class Foo");
    expect(ops[0]!.hunks![1]!.eof).toBe(true);
  });

  it("pathsFromApplyPatch reads headers only", () => {
    expect(pathsFromApplyPatch(sampleWithoutEndFile)).toEqual([
      "/Users/zyf/workspace/web/test/src/vehicle.js",
    ]);
    expect(pathsFromApplyPatch(sampleWithEndFile)).toEqual(["a.js", "b.js"]);
    expect(
      pathsFromApplyPatch(`*** Begin Patch
*** Update File: a.ts
*** Move to: b.ts
*** End Patch`),
    ).toEqual(["a.ts", "b.ts"]);
  });
});

describe("applyHunk miss hint", () => {
  it("includes a closest file window when context/removed lines miss", () => {
    const original = "alpha\nhello world\ngamma\n";
    const patch = `*** Begin Patch
*** Update File: f.txt
@@
-hello wrld
+hello earth
*** End Patch`;
    const ops = parsePatch(patch);
    const hunk = ops[0]!.hunks![0]!;
    expect(() => applyHunk(original, hunk)).toThrow(/Closest in file:\nhello world/);
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
    expect(res.content).toMatch(/\+ added new\.js \(\+1\)/);
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

  it("refuses Add File even when the existing file was observed this session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-add-"));
    const p = join(dir, "seen.js");
    writeFileSync(p, "const original = 1;\n");
    const store = new FileObservationStore();
    const ctx = patchCtx(dir, store);
    await readFileTool.execute({ path: "seen.js" }, ctx);
    const patch = `*** Begin Patch
*** Add File: seen.js
+const replaced = 2;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/already exists/);
    expect(readFileSync(p, "utf-8")).toBe("const original = 1;\n");
  });

  it("Update File applies when hunk matches disk even if never read_file'd", async () => {
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
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/~ updated u\.js \(\+1\/-1\)/);
    expect(readFileSync(p, "utf-8")).toBe("b\n");
  });

  it("chains multiple Update File ops on the same path (no clobber)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-chain-"));
    const p = join(dir, "discounts.js");
    writeFileSync(
      p,
      [
        "export function bulk(qty) {",
        "  if (qty > 10) {",
        "    return 1;",
        "  }",
        "  return 0;",
        "}",
        "export function coupon(c) {",
        '  if (c === "SAVE15") {',
        "    return 1;",
        "  }",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Update File: discounts.js
@@
-  if (qty > 10) {
+  if (qty >= 10) {
*** Update File: discounts.js
@@
-  if (c === "SAVE15") {
+  if (c.toUpperCase() === "SAVE15") {
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBeUndefined();
    // Two same-path Updates accumulate hunk stats.
    expect(res.content).toMatch(/~ updated discounts\.js \(\+2\/-2\)/);
    const after = readFileSync(p, "utf-8");
    expect(after).toContain("if (qty >= 10) {");
    expect(after).toContain('if (c.toUpperCase() === "SAVE15") {');
    expect(after).not.toContain("if (qty > 10) {");
  });

  it("Update File refuses when hunk context does not match disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-add-"));
    const p = join(dir, "u.js");
    writeFileSync(p, "a\n");
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Update File: u.js
@@
-zzz
+b
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("a\n");
  });

  it("applies a hunk whose context differs only by typography (curly quotes)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-typo-"));
    const p = join(dir, "t.js");
    // Source has REAL curly quotes; the patch context uses straight quotes.
    writeFileSync(p, 'const a = \u201Chi\u201D;\nconst b = 2;\n');
    const store = new FileObservationStore();
    const ctx = patchCtx(dir, store);
    await readFileTool.execute({ path: "t.js" }, ctx);
    const patch = `*** Begin Patch
*** Update File: t.js
@@
 const a = "hi";
-const b = 2;
+const b = 3;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, ctx);
    expect(res.isError).toBeUndefined();
    const after = readFileSync(p, "utf-8");
    expect(after).toContain("const b = 3;");
    // The curly-quoted line was matched as context and left exactly as it was.
    expect(after).toContain('const a = \u201Chi\u201D;');
  });

  it("Move to: renames and applies hunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-mv-"));
    writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@
-export const a = 1;
+export const a = 2;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/moved old\.ts → new\.ts/);
    expect(existsSync(join(dir, "old.ts"))).toBe(false);
    expect(readFileSync(join(dir, "new.ts"), "utf-8")).toContain("a = 2");
  });

  it("@@ change_context and End of File seek disambiguate duplicate blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-eof-"));
    writeFileSync(
      join(dir, "dup.ts"),
      ["class A {", "  x = 1;", "}", "class B {", "  x = 1;", "}"].join("\n") + "\n",
    );
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Update File: dup.ts
@@ class B
-  x = 1;
+  x = 2;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBeUndefined();
    const after = readFileSync(join(dir, "dup.ts"), "utf-8");
    expect(after).toContain("class A {\n  x = 1;");
    expect(after).toContain("class B {\n  x = 2;");
  });

  it("preserves CRLF line endings on update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-crlf-"));
    const p = join(dir, "win.js");
    writeFileSync(p, "const a = 1;\r\nconst b = 2;\r\n");
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Update File: win.js
@@
-const b = 2;
+const b = 3;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBeUndefined();
    const after = readFileSync(p, "utf-8");
    expect(after).toBe("const a = 1;\r\nconst b = 3;\r\n");
  });

  it("rejects an ambiguous hunk that matches more than once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-ap-amb-"));
    writeFileSync(
      join(dir, "dup.ts"),
      ["class A {", "  x = 1;", "}", "class B {", "  x = 1;", "}"].join("\n") + "\n",
    );
    const store = new FileObservationStore();
    const patch = `*** Begin Patch
*** Update File: dup.ts
@@
-  x = 1;
+  x = 2;
*** End Patch`;
    const res = await applyPatchTool.execute({ patch }, patchCtx(dir, store));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/ambiguous match/);
    expect(readFileSync(join(dir, "dup.ts"), "utf-8")).toContain("  x = 1;");
  });
});

describe("applyHunk CRLF / ambiguity unit", () => {
  it("keeps CRLF when splicing", () => {
    const out = applyHunk("a\r\nb\r\nc\r\n", {
      lines: [
        { type: "ctx", text: "a" },
        { type: "del", text: "b" },
        { type: "add", text: "B" },
        { type: "ctx", text: "c" },
      ],
    });
    expect(out).toBe("a\r\nB\r\nc\r\n");
  });

  it("throws on ambiguous exact match", () => {
    expect(() =>
      applyHunk("x\nx\n", {
        lines: [
          { type: "del", text: "x" },
          { type: "add", text: "y" },
        ],
      }),
    ).toThrow(/ambiguous/);
  });
});
