/**
 * listFilesForCompletion — returns up to `max` file/directory entries under
 * `cwd` matching a prefix, for the `@path` autocomplete in the TUI input.
 *
 * Behavior:
 *  - Walks one or two levels deep to keep latency low (we're typing in a
 *    TTY; even 50ms feels laggy). For deeper paths, the user narrows by
 *    typing more and we re-scan with the longer prefix.
 *  - Respects a small set of ignore rules (node_modules, .git, dist, build
 *    output, hidden dirs) so the menu isn't flooded with noise.
 *  - Returns relative paths (POSIX) for display; the caller inserts them
 *    after the `@` token.
 *  - Directories are suffixed with `/` so the user knows they can keep
 *    descending.
 *
 * This is intentionally synchronous + cached: the TUI input loop calls this
 * on every keystroke when the cursor is in an `@` token, so it must be fast.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".pnpm-store",
  "coverage",
  ".DS_Store",
]);

const MAX_DEPTH = 3;
const MAX_RESULTS = 60;

export interface ListOptions {
  /** Max entries to return. Defaults to 60. */
  max?: number;
  /** Max directory depth to walk. Defaults to 3. */
  maxDepth?: number;
}

/**
 * Returns relative POSIX paths under `cwd` that start with `prefix`.
 * Directories end with `/`.
 */
export function listFilesForCompletion(
  cwd: string,
  prefix: string,
  opts: ListOptions = {},
): string[] {
  const max = opts.max ?? MAX_RESULTS;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const results: string[] = [];

  // Normalize the prefix: strip a leading "./" the user may have typed.
  const cleanPrefix = prefix.replace(/^\.\//, "");
  // The directory portion of the prefix tells us where to start scanning.
  const lastSlash = cleanPrefix.lastIndexOf("/");
  const startDir = lastSlash >= 0 ? cleanPrefix.slice(0, lastSlash) : "";
  const filePrefix = lastSlash >= 0 ? cleanPrefix.slice(lastSlash + 1) : cleanPrefix;

  const absStart = startDir.length === 0 ? cwd : join(cwd, startDir);
  const baseRel = startDir; // relative path prefix to prepend to each found entry

  try {
    walk(absStart, baseRel, 0, filePrefix, results, max, maxDepth);
  } catch {
    // cwd may not exist or be unreadable; return whatever we have.
  }
  // Sort: directories first, then files, alphabetically.
  results.sort((a, b) => {
    const aDir = a.endsWith("/");
    const bDir = b.endsWith("/");
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return results.slice(0, max);
}

function walk(
  dir: string,
  relBase: string,
  depth: number,
  prefix: string,
  out: string[],
  max: number,
  maxDepth: number,
): void {
  if (out.length >= max) return;
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= max) return;
    if (name.startsWith(".") && depth > 0) continue; // skip hidden except at top
    if (IGNORE.has(name)) continue;
    if (!name.startsWith(prefix)) continue;
    const abs = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    const rel = relBase.length === 0 ? name : `${relBase}/${name}`;
    if (isDir) {
      out.push(rel + "/");
      // Recurse one level deeper to surface nested matches cheaply.
      walk(abs, rel, depth + 1, "", out, max, maxDepth);
    } else {
      out.push(rel);
    }
  }
}

/** Convert a native relative path to POSIX for display. */
export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
