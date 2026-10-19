import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isIgnoredDirName,
  shouldSkipWalkDir,
  DEFAULT_IGNORED_REL_PATHS,
} from "../src/tools/_shared.js";
import { grepTool } from "../src/tools/grep.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    artifact: async () => "art_x",
    readArtifact: async () => "",
  };
}

describe("ignore path helpers", () => {
  it("treats basename ignores as before", () => {
    expect(isIgnoredDirName("node_modules")).toBe(true);
    expect(isIgnoredDirName("artifacts")).toBe(false);
    expect(isIgnoredDirName(".codepilot")).toBe(false);
  });

  it("skips .codepilot/artifacts via relative path, not basename alone", () => {
    expect(shouldSkipWalkDir(".codepilot/artifacts", "artifacts")).toBe(true);
    expect(shouldSkipWalkDir(".codepilot/jobs", "jobs")).toBe(true);
    expect(shouldSkipWalkDir(".codepilot/cache", "cache")).toBe(true);
 // plans/config under .codepilot must remain searchable
    expect(shouldSkipWalkDir(".codepilot", ".codepilot")).toBe(false);
    expect(shouldSkipWalkDir(".codepilot/plans", "plans")).toBe(false);
    expect(DEFAULT_IGNORED_REL_PATHS.has(".codepilot/artifacts")).toBe(true);
  });
});

describe("grep skips artifact spill", () => {
  it("does not return hits from .codepilot/artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-grep-ign-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".codepilot", "artifacts"), { recursive: true });
    await writeFile(join(root, "src", "ok.ts"), "export const UNIQUE_MARKER = 1;\n");
    await writeFile(
      join(root, ".codepilot", "artifacts", "spill.txt"),
      "UNIQUE_MARKER should not be found here\n",
    );

    const result = await grepTool.execute({ pattern: "UNIQUE_MARKER" }, ctx(root));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("src/ok.ts");
    expect(result.content).not.toContain(".codepilot/artifacts");
  });
});
