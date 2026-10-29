import { describe, expect, it } from "vitest";
import { DoomLoopDetector } from "../src/doomLoop.js";

// The old "mutation burst" brake (N consecutive edits on the same path without
// an intervening verify command => warn then refuse) was removed. It was a
// CodePilot-only mechanism that no mainstream harness implements, it was
// internally inconsistent with the path-read layer (which never refuses on a
// count, precisely to avoid false-positives on legitimate iteration), and even
// as a warning it polluted the model's context — weaker models would "believe"
// the warning and abandon productive work (e.g. building up a large file section
// by section). These tests pin the NEW guarantee: editing the same file many
// times in a row is never penalised by the doom-loop detector.
describe("no mutation-burst brake", () => {
  it("never warns or refuses on many consecutive edits to the same file", () => {
    const d = new DoomLoopDetector();
    // Far more than the old refuse threshold (8), each a DISTINCT edit.
    for (let i = 0; i < 20; i++) {
      const r = d.check("edit_file", { path: "f.ts", search: `a${i}`, replace: `b${i}` });
      expect(r.refuse).toBe(false);
      expect(r.warn).toBe(false);
    }
  });

  it("never warns or refuses on many consecutive write_file calls to the same path", () => {
    const d = new DoomLoopDetector();
    for (let i = 0; i < 20; i++) {
      const r = d.check("write_file", { path: "big.ts", content: `section ${i}` });
      expect(r.refuse).toBe(false);
      expect(r.warn).toBe(false);
    }
  });

  it("still refuses the genuine loop: the EXACT same edit repeated verbatim", () => {
    // Removing the burst brake must not weaken the exact-repetition layer, which
    // catches a true no-progress loop (identical tool + identical input).
    const d = new DoomLoopDetector();
    let sawRefuse = false;
    for (let i = 0; i < 6; i++) {
      const r = d.check("edit_file", { path: "f.ts", search: "same", replace: "same" });
      if (r.refuse) sawRefuse = true;
    }
    expect(sawRefuse).toBe(true);
  });
});
