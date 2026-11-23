import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isIgnoredDirName,
  shouldSkipWalkDir,
  DEFAULT_IGNORED_REL_PATHS,
  rgVcsExcludeArgs,
  rgRuntimeExcludeArgs,
  VCS_DIR_NAMES,
} from "../src/tools/_shared.js";
import { grepTool } from "../src/tools/grep.js";
import { globTool } from "../src/tools/glob.js";
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

  it("includeIgnored still skips VCS roots but allows node_modules", () => {
    expect(shouldSkipWalkDir("node_modules", "node_modules", true)).toBe(false);
    expect(shouldSkipWalkDir(".git", ".git", true)).toBe(true);
    expect(shouldSkipWalkDir(".jj", ".jj", true)).toBe(true);
  });

  it("rgVcsExcludeArgs emits dual globs per VCS name", () => {
    const args = rgVcsExcludeArgs();
    for (const name of VCS_DIR_NAMES) {
      expect(args).toContain(`--glob=!**/${name}`);
      expect(args).toContain(`--glob=!**/${name}/**`);
    }
  });

  it("rgRuntimeExcludeArgs covers .codepilot spill dirs", () => {
    const args = rgRuntimeExcludeArgs();
    expect(args.some((a) => a.includes(".codepilot/artifacts"))).toBe(true);
    expect(args.some((a) => a.includes(".codepilot/jobs"))).toBe(true);
  });
});

describe("grep --hidden finds non-ignored dotdirs", () => {
  it("searches .github by default (rg --hidden)", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-grep-hidden-"));
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".github", "workflows", "ci.yml"),
      "name: HIDDEN_CI_MARKER\n",
    );
    await writeFile(join(root, "README.md"), "no marker here\n");
    const result = await grepTool.execute(
      { pattern: "HIDDEN_CI_MARKER" },
      { ...ctx(root), config: { grep: { backend: "rg" } } as ToolContext["config"] },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/\.github/);
    expect(result.content).toContain("HIDDEN_CI_MARKER");
  });
});

describe("includeIgnored does not search .git via walker", () => {
  it("grep walker skips .git even with includeIgnored", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-grep-vcs-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await writeFile(join(root, "src", "ok.ts"), "export const VCS_MARKER = 1;\n");
    await writeFile(join(root, ".git", "objects", "pack"), "VCS_MARKER must not match\n");

    const result = await grepTool.execute(
      { pattern: "VCS_MARKER", includeIgnored: true },
      { ...ctx(root), config: { grep: { backend: "walker" } } as ToolContext["config"] },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("src/ok.ts");
    expect(result.content).not.toContain(".git");
  });

  it("glob accepts path as cwd alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-glob-path-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "a.ts"), "x\n");
    const result = await globTool.execute(
      { pattern: "*.ts", path: "sub" },
      ctx(root),
    );
    expect(result.content).toMatch(/a\.ts/);
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
