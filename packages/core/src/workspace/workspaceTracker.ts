// Whole-workspace turn snapshots via a shadow git repository. Per-file
// snapshots (snapshots.ts) only see files written by the
// file tools; a tree snapshot also captures what bash/MCP changed, so /undo can
// revert `sed -i`, codegen, `rm`, `mv` and friends.
//
// The shadow repo lives in project state (never the user's .git). Its work tree
// is the repository top level so every .gitignore applies, while the pathspec
// limits tracking to the session cwd. Each session uses its own index file so
// concurrent sessions never contend for one index.lock. Trees still on a
// session's undo/redo stacks are pinned by refs (refs/codepilot/<session>/) so
// gc only prunes intermediate snapshots. Fail-soft: outside a git repo, or
// after any git error/timeout, the tracker is disabled and undo falls back to
// the per-file snapshots.

import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { projectStatePath } from "./projectState.js";

const GIT_TIMEOUT_MS = 20_000;
const GITLINK_MODE = "160000";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A session idle this long loses its index file and pins. */
const STALE_SESSION_MS = 30 * DAY_MS;
const GC_INTERVAL_MS = 7 * DAY_MS;
const REF_ROOT = "refs/codepilot";

export interface TreeChange {
  /** Path relative to the session cwd. */
  path: string;
  /** Present in the target tree (restore it) vs. absent (delete it). */
  inTarget: boolean;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  return env;
}

function run(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(
      "git",
      args,
      { cwd: opts.cwd, env: opts.env, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? fail(err) : done(stdout)),
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export class WorkspaceTracker {
  private disabled = false;

  private constructor(
    private readonly cwd: string,
    private readonly top: string,
    /** cwd relative to `top`, POSIX separators; "" when cwd is the top level. */
    private readonly scope: string,
    private readonly env: NodeJS.ProcessEnv,
    /** Filesystem/ref-safe session key. */
    private readonly sid: string,
  ) {}

  private toTop(cwdRel: string): string {
    const posix = cwdRel.split(sep).join("/");
    return this.scope ? `${this.scope}/${posix}` : posix;
  }

  private fromTop(topRel: string): string {
    const rel = this.scope && topRel.startsWith(`${this.scope}/`) ? topRel.slice(this.scope.length + 1) : topRel;
    return rel.split("/").join(sep);
  }

  /** Open the tracker for `cwd`, or null when it is not inside a git work tree
   * (or git is unavailable). */
  static async open(cwd: string, sessionId: string): Promise<WorkspaceTracker | null> {
    const base = cleanGitEnv();
    let top: string;
    let commonDir: string;
    let prefix: string;
    try {
      // --show-prefix (not relative(top, cwd)): top is a realpath, cwd may be
      // reached through a symlink (macOS /var → /private/var).
      const out = await run(["rev-parse", "--show-toplevel", "--git-common-dir", "--show-prefix"], {
        cwd,
        env: base,
      });
      [top, commonDir, prefix = ""] = out.split("\n") as [string, string, string?];
      if (!top || !commonDir) return null;
    } catch {
      return null;
    }
    const gitDir = projectStatePath(cwd, "shadow-git");
    const sid = sessionId.replace(/[^\w-]/g, "_");
    const env: NodeJS.ProcessEnv = {
      ...base,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: top,
      GIT_INDEX_FILE: join(gitDir, `index-${sid}`),
      GIT_LITERAL_PATHSPECS: "1",
      // The user's global/system config can carry LFS filters, fsmonitor hooks
      // or autocrlf that would make snapshots slow or lossy.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    try {
      if (!existsSync(join(gitDir, "HEAD"))) {
        await mkdir(gitDir, { recursive: true });
        await run(["init", "-q"], { cwd: top, env });
        for (const [k, v] of [["core.autocrlf", "false"], ["gc.auto", "0"], ["core.quotepath", "false"]]) {
          await run(["config", k!, v!], { cwd: top, env });
        }
      }
      // Honour the real repo's local excludes too.
      const exclude = resolve(cwd, commonDir, "info", "exclude");
      if (existsSync(exclude)) {
        await mkdir(join(gitDir, "info"), { recursive: true });
        await copyFile(exclude, join(gitDir, "info", "exclude"));
      }
    } catch {
      return null;
    }
    void maintain(gitDir, top, env);
    return new WorkspaceTracker(resolve(cwd), top, prefix.replace(/\/$/, ""), env, sid);
  }

  /** Make this session's pins exactly `trees` (the trees its undo/redo stacks
   * still reference); everything else becomes collectable. */
  async pin(trees: Iterable<string>): Promise<void> {
    if (this.disabled) return;
    const want = new Set(trees);
    const prefix = `${REF_ROOT}/${this.sid}/`;
    try {
      const have = new Set(
        (await run(["for-each-ref", "--format=%(refname)", prefix], { cwd: this.top, env: this.env }))
          .split("\n")
          .filter(Boolean)
          .map((r) => r.slice(prefix.length)),
      );
      const ops = [
        ...[...want].filter((t) => !have.has(t)).map((t) => `create ${prefix}${t} ${t}`),
        ...[...have].filter((t) => !want.has(t)).map((t) => `delete ${prefix}${t}`),
      ];
      if (ops.length > 0) {
        await run(["update-ref", "--stdin"], { cwd: this.top, env: this.env, input: `${ops.join("\n")}\n` });
      }
    } catch {
      /* unpinned trees just become collectable */
    }
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  /** Snapshot the workspace and return its tree hash (null when disabled). */
  async capture(): Promise<string | null> {
    if (this.disabled) return null;
    try {
      await run(["add", "-A", "--", this.scope || "."], { cwd: this.top, env: this.env });
      return (await run(["write-tree"], { cwd: this.top, env: this.env })).trim() || null;
    } catch {
      this.disabled = true;
      return null;
    }
  }

  /** Paths that differ between `from` and `target`, oriented so applying them
   * makes the workspace match `target`. Gitlinks (submodules) are skipped. */
  async changes(from: string, target: string): Promise<TreeChange[]> {
    if (from === target) return [];
    const out = await run(["diff-tree", "-r", "-z", "--no-renames", from, target], {
      cwd: this.top,
      env: this.env,
    });
    const parts = out.split("\0");
    const changes: TreeChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = parts[i]!.replace(/^\n/, "");
      const path = parts[i + 1]!;
      // ":<srcmode> <dstmode> <srcsha> <dstsha> <status>"
      const [srcMode, dstMode, , , status] = meta.slice(1).split(" ");
      if (!status || srcMode === GITLINK_MODE || dstMode === GITLINK_MODE) continue;
      changes.push({ path: this.fromTop(path), inTarget: status !== "D" });
    }
    return changes;
  }

  /** Make every path in `changes` match tree `target`: check present ones out
   * of the tree, delete absent ones. */
  async restore(target: string, changes: TreeChange[]): Promise<void> {
    const present = changes.filter((c) => c.inTarget);
    if (present.length > 0) {
      const specs = present.map((c) => this.toTop(c.path)).join("\0");
      await run(["checkout", target, "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: this.top,
        env: this.env,
        input: specs,
      });
    }
    for (const c of changes) {
      if (!c.inTarget) await rm(resolve(this.cwd, c.path), { force: true });
    }
  }
}

/** Weekly: forget sessions idle for 30 days (index file + pins), then prune
 * unpinned snapshot objects older than a week. */
async function maintain(gitDir: string, top: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const now = Date.now();
    const stamp = join(gitDir, "codepilot-gc");
    if (existsSync(stamp) && now - (await stat(stamp)).mtimeMs < GC_INTERVAL_MS) return;
    const stale: string[] = [];
    for (const name of await readdir(gitDir)) {
      if (!name.startsWith("index-")) continue;
      const p = join(gitDir, name);
      if (now - (await stat(p)).mtimeMs > STALE_SESSION_MS) {
        await rm(p, { force: true });
        stale.push(name.slice("index-".length));
      }
    }
    for (const sid of stale) {
      const refs = (await run(["for-each-ref", "--format=%(refname)", `${REF_ROOT}/${sid}/`], { cwd: top, env }))
        .split("\n")
        .filter(Boolean);
      if (refs.length > 0) {
        await run(["update-ref", "--stdin"], { cwd: top, env, input: refs.map((r) => `delete ${r}\n`).join("") });
      }
    }
    await run(["gc", "--quiet", "--prune=7.days.ago"], { cwd: top, env });
    // Stamped only after gc succeeds: git refuses a second concurrent gc
    // ("gc is already running"), and a stamp written beforehand would suppress
    // the retry for a week while unpinned objects pile up.
    await writeFile(stamp, "");
  } catch {
    /* best-effort */
  }
}
