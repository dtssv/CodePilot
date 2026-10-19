// Shared helpers for built-in tools: sandbox path guard + ignore lists.

import type { ToolContext, ToolResult } from "./types.js";
import { assertPathAllowedAsync } from "../sandbox.js";

/**
 * Directory *names* that glob/grep skip by default (unless the caller passes
 * `includeIgnored: true`). Compared against a single path segment (`ent.name`).
 */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".pnpm-store",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "coverage",
  ".idea",
  ".gradle",
]);

/**
 * Relative path prefixes (from the search root) that must be skipped even
 * when the leaf directory name alone is not in {@link DEFAULT_IGNORED_DIRS}.
 *
 * IMPORTANT: these cannot be checked with `ent.name` alone — e.g.
 * `.codepilot/artifacts` never appears as a single directory name, so a
 * name-only ignore silently fails and greps pollute results with old
 * spilled tool output.
 */
export const DEFAULT_IGNORED_REL_PATHS: ReadonlySet<string> = new Set([
  ".codepilot/artifacts",
  ".codepilot/jobs",
  ".codepilot/cache",
  ".codepilot/sessions",
]);

/** True when `name` is a known heavy/cache directory basename. */
export function isIgnoredDirName(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(name);
}

/**
 * True when a walker should skip this directory entry.
 *
 * @param relPath Path of the entry relative to the search root, using `/`
 * separators (e.g. `.codepilot/artifacts`). Pass the child
 * path you are about to descend into, not the parent.
 * @param name The entry's basename (`ent.name`).
 */
export function shouldSkipWalkDir(relPath: string, name: string): boolean {
  if (DEFAULT_IGNORED_DIRS.has(name)) return true;
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (DEFAULT_IGNORED_REL_PATHS.has(norm)) return true;
  for (const prefix of DEFAULT_IGNORED_REL_PATHS) {
    if (norm.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * Validate a path against the active sandbox policy. Returns null when the
 * access is allowed, or an error ToolResult ready to return to the model.
 */
export async function guardPath(
  ctx: ToolContext,
  path: string,
  kind: "read" | "write"
): Promise<ToolResult | null> {
  if (!ctx.sandbox) return null;
  const check = await assertPathAllowedAsync(path, kind, ctx.sandbox, ctx.cwd);
  if (check.ok) return null;
  return { content: check.reason ?? "sandbox: path not allowed", isError: true };
}
