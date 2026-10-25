import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProjectGuidance } from "../src/projectInit.js";

describe("initProjectGuidance", () => {
  it("writes AGENTS.md with stack hints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "init-"));
    writeFileSync(join(dir, "package.json"), "{}");
    const r = await initProjectGuidance(dir);
    expect(r.created).toBe(true);
    const text = readFileSync(r.path, "utf-8");
    expect(text).toContain("## Stack");
    expect(text).toContain("package.json");
    expect(text).toContain("/init");
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips when file exists unless force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "init2-"));
    writeFileSync(join(dir, "AGENTS.md"), "keep me\n");
    const skip = await initProjectGuidance(dir);
    expect(skip.skipped).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe("keep me\n");
    const forced = await initProjectGuidance(dir, { force: true });
    expect(forced.created).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toContain("Conventions");
    rmSync(dir, { recursive: true, force: true });
  });
});
