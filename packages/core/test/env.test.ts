import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultEnvironmentProvider } from "../src/env.js";

describe("defaultEnvironmentProvider", () => {
  it("returns a non-empty snapshot for a real cwd", async () => {
    const snap = await defaultEnvironmentProvider.snapshot(process.cwd());
    expect(snap.cwd).toBe(process.cwd());
    expect(snap.os.length).toBeGreaterThan(0);
    expect(snap.shell.length).toBeGreaterThan(0);
    expect(snap.node).toMatch(/^v\d+\./);
    expect(snap.now).toMatch(/T/);
    expect(snap.timezone.length).toBeGreaterThan(0);
 // host / user should be non-empty on a real machine.
    expect(snap.hostname.length).toBeGreaterThan(0);
    expect(snap.user.length).toBeGreaterThan(0);
  });

  it("returns inRepo=true and a branch when run inside a real git work tree", async () => {
 // This is best-effort: the workspace itself is a git repo.
    let gitOk = true;
    try {
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
    } catch {
      gitOk = false;
    }
    if (!gitOk) return; // Skip the assertion on hosts without git.
    const snap = await defaultEnvironmentProvider.snapshot(process.cwd());
    expect(snap.git).toBeDefined();
    expect(snap.git?.inRepo).toBe(true);
    expect(snap.git?.root).toBeTruthy();
    expect(snap.git?.branch).toBeTruthy();
  });

  it("returns inRepo=false for a directory that is not a git work tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      const snap = await defaultEnvironmentProvider.snapshot(dir);
 // inRepo is false (or git field undefined if execFile failed before the
 // top-level lookup returned anything).
      expect(snap.git?.inRepo === false || snap.git === undefined).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports git identity without walking the dirty working tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-ident-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "hello", "utf-8");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "hello world", "utf-8");
      const snap = await defaultEnvironmentProvider.snapshot(dir);
      expect(snap.git?.inRepo).toBe(true);
      expect(snap.git?.branch).toBe("main");
      expect(snap.git?.lastCommit).toBe("init");
      expect(snap.git?.lastCommitSha).toBeTruthy();
      // Dirty status is intentionally not collected for the prompt snapshot.
      expect(snap.git).not.toHaveProperty("dirty");
      expect(snap.git).not.toHaveProperty("statusShort");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
