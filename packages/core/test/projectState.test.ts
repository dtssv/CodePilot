import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensureProjectState,
  projectHash,
  projectStatePath,
  projectStateRoot,
  scratchDir,
} from "../src/projectState.js";

describe("projectState", () => {
  it("roots runtime state under ~/.codepilot/projects/<hash>", () => {
    const cwd = "/repo/demo";
    const hash = projectHash(cwd);
    expect(projectStateRoot(cwd)).toBe(join(homedir(), ".codepilot", "projects", hash));
    expect(projectStatePath(cwd, "artifacts")).toBe(
      join(homedir(), ".codepilot", "projects", hash, "artifacts"),
    );
    expect(scratchDir(cwd, "sess-1")).toBe(
      join(homedir(), ".codepilot", "projects", hash, "scratch", "sess-1"),
    );
  });

  it("ensureProjectState writes a cwd marker and creates scratch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-"));
    const { root, scratch } = await ensureProjectState(dir, { sessionId: "s1" });
    expect(root).toBe(projectStateRoot(dir));
    expect(scratch).toBe(scratchDir(dir, "s1"));
    expect(readFileSync(join(root, "cwd"), "utf8").trim()).toBe(resolve(dir));
    rmSync(dir, { recursive: true, force: true });
  });
});
