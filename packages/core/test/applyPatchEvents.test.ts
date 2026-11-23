import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchTool } from "../src/tools/apply_patch.js";
import type { ToolContext } from "../src/tools/types.js";
import type { Event } from "../src/types.js";

describe("apply_patch edit_delta events", () => {
  it("emits one edit_delta per committed file op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cp-patch-ev-"));
    writeFileSync(join(dir, "a.ts"), "const x = 1;\n", "utf-8");
    const events: Event[] = [];
    const ctx = {
      cwd: dir,
      artifact: async () => "art",
      readArtifact: async () => "",
      emitEvent: (e: Event) => {
        events.push(e);
      },
    } as ToolContext;

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-const x = 1;",
      "+const x = 2;",
      "*** Add File: b.ts",
      "+export const y = 3;",
      "*** End Patch",
    ].join("\n");

    const r = await applyPatchTool.execute({ patch }, ctx);
    expect(r.isError).toBeFalsy();
    const deltas = events.filter((e) => e.type === "edit_delta");
    expect(deltas.length).toBe(2);
    expect(deltas.map((e) => (e as { strategy: string }).strategy).sort()).toEqual(["add", "update"]);
  });
});
