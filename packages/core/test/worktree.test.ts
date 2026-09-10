import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  createWorktree,
  removeWorktree,
  resolveRepoRoot,
  worktreeDiffStat,
  isGitAvailable,
} from "../src/worktree.js";

/** Initialise a throwaway git repo at `dir` with one commit on `main`. */
function initRepo(dir: string): void {
  // A stable identity keeps git happy in CI / sandboxes.
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: ["ignore", "ignore", "ignore"] });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "test"]);
  git(["config", "user.email", "test@test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
}

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cp-wt-"));
  repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** macOS resolves /tmp → /private/tmp via symlink. git's --show-toplevel
 *  returns the canonical (symlink-resolved) path, so tests must compare
 *  against realpathSync(dir) to avoid spurious mismatches. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

describe("resolveRepoRoot", () => {
  it("returns the repo root inside a git repo", async () => {
    initRepo(repo);
    const root = await resolveRepoRoot(repo);
    expect(root).toBe(real(repo));
  });

  it("returns null outside a git repo", async () => {
    const root = await resolveRepoRoot(tmp);
    expect(root).toBeNull();
  });
});

describe("isGitAvailable", () => {
  it("true inside a git repo", async () => {
    initRepo(repo);
    expect(await isGitAvailable(repo)).toBe(true);
  });

  it("false outside a git repo", async () => {
    expect(await isGitAvailable(tmp)).toBe(false);
  });
});

describe("createWorktree", () => {
  beforeEach(() => initRepo(repo));

  it("creates a linked worktree on a fresh branch", async () => {
    const r = await createWorktree({ cwd: repo, label: "review" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wt = r.worktree;
    expect(wt.path).toContain("cp-worktree-");
    expect(wt.branch).toMatch(/^cp-review-[a-f0-9]{8}$/);
    expect(wt.baseRef).toBe("HEAD");
    expect(wt.repoRoot).toBe(real(repo));
    // The worktree path should exist and be a separate checkout.
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(readFileSync(join(wt.path, "README.md"), "utf-8")).toContain("# test");
    // Clean up so afterEach's rmSync doesn't fight git's worktree metadata.
    await removeWorktree(wt);
  });

  it("returns not-a-repo when cwd is not a git repo", async () => {
    const r = await createWorktree({ cwd: tmp, label: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-a-repo");
  });

  it("sanitises the label into the branch name", async () => {
    const r = await createWorktree({ cwd: repo, label: "My Funky Label!!" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.worktree.branch).toMatch(/^cp-my-funky-label-[a-f0-9]{8}$/);
    await removeWorktree(r.worktree);
  });

  it("uses a custom baseRef", async () => {
    // Create a second commit, then create a worktree from the first commit.
    const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test" };
    const firstSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env }).toString().trim();
    writeFileSync(join(repo, "second.txt"), "second\n");
    execFileSync("git", ["add", "second.txt"], { cwd: repo, env });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: repo, env });
    const r = await createWorktree({ cwd: repo, baseRef: firstSha });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The worktree should NOT have second.txt (it was created from firstSha).
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(r.worktree.path, "second.txt"))).toBe(false);
    expect(existsSync(join(r.worktree.path, "README.md"))).toBe(true);
    await removeWorktree(r.worktree);
  });
});

describe("removeWorktree", () => {
  beforeEach(() => initRepo(repo));

  it("removes the worktree and its branch by default", async () => {
    const r = await createWorktree({ cwd: repo, label: "tmp" });
    if (!r.ok) throw new Error("create failed");
    const wt = r.worktree;
    await removeWorktree(wt);
    // Path should be gone.
    const { existsSync } = await import("node:fs");
    expect(existsSync(wt.path)).toBe(false);
    // Branch should be deleted.
    expect(() =>
      execFileSync("git", ["rev-parse", "--verify", wt.branch], { cwd: repo, stdio: "ignore" })
    ).toThrow();
  });

  it("keeps the branch when keepBranch is true", async () => {
    const r = await createWorktree({ cwd: repo, label: "keep" });
    if (!r.ok) throw new Error("create failed");
    const wt = r.worktree;
    await removeWorktree(wt, { keepBranch: true });
    const { existsSync } = await import("node:fs");
    expect(existsSync(wt.path)).toBe(false);
    // Branch should still resolve.
    expect(() =>
      execFileSync("git", ["rev-parse", "--verify", wt.branch], { cwd: repo, stdio: "ignore" })
    ).not.toThrow();
  });

  it("is idempotent (safe to call twice)", async () => {
    const r = await createWorktree({ cwd: repo, label: "idem" });
    if (!r.ok) throw new Error("create failed");
    const wt = r.worktree;
    await removeWorktree(wt);
    // Second call should not throw.
    await expect(removeWorktree(wt)).resolves.toEqual({ ok: true });
  });
});

describe("worktreeDiffStat", () => {
  beforeEach(() => initRepo(repo));

  it("returns empty string for a clean worktree", async () => {
    const r = await createWorktree({ cwd: repo, label: "clean" });
    if (!r.ok) throw new Error("create failed");
    const stat = await worktreeDiffStat(r.worktree);
    expect(stat).toBe("");
    await removeWorktree(r.worktree);
  });

  it("returns a diff stat after editing a file in the worktree", async () => {
    const r = await createWorktree({ cwd: repo, label: "edit" });
    if (!r.ok) throw new Error("create failed");
    const wt = r.worktree;
    // Edit a file inside the worktree.
    writeFileSync(join(wt.path, "README.md"), "# changed\n");
    const stat = await worktreeDiffStat(wt);
    expect(stat).toContain("README.md");
    // The parent repo should be UNAFFECTED — isolation works.
    const parentReadme = await import("node:fs").then((m) =>
      m.readFileSync(join(repo, "README.md"), "utf-8")
    );
    expect(parentReadme).toBe("# test\n");
    await removeWorktree(wt);
  });
});

describe("isolation: parallel worktrees don't collide", () => {
  beforeEach(() => initRepo(repo));

  it("two worktrees get distinct paths and branches", async () => {
    const [a, b] = await Promise.all([
      createWorktree({ cwd: repo, label: "alpha" }),
      createWorktree({ cwd: repo, label: "beta" }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.worktree.path).not.toBe(b.worktree.path);
    expect(a.worktree.branch).not.toBe(b.worktree.branch);
    // Edit in A, verify B is unaffected.
    writeFileSync(join(a.worktree.path, "only-a.txt"), "a\n");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(a.worktree.path, "only-a.txt"))).toBe(true);
    expect(existsSync(join(b.worktree.path, "only-a.txt"))).toBe(false);
    await removeWorktree(a.worktree);
    await removeWorktree(b.worktree);
  });
});
