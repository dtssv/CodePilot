// Shared helpers for built-in tools: sandbox path guard + ignore lists.

import type { ToolContext, ToolResult } from "./types.js";
import { assertPathAllowedAsync } from "../sandbox.js";

/**
 * Directories that glob/grep/ls skip by default (unless the caller passes
 * `includeIgnored: true`). Mirrors the ignore sets used by claude-code and
 * ripgrep's default hidden/ignore behaviour for the heaviest offenders.
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
  ".codepilot/artifacts",
  ".codepilot/jobs",
]);

export function isIgnoredDirName(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(name);
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
