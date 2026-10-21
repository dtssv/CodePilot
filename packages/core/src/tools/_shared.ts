// Shared helpers for built-in tools: sandbox path guard + ignore lists.

import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { assertPathAllowedAsync } from "../sandbox.js";
import {
  isUnderDeliveryRoots,
  mergeDeliveryRoots,
  normalizeRoot,
} from "../deliveryRoots.js";

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

/** Paths under CodePilot runtime state / scratch are never "deliverables". */
function isDeliveryExempt(abs: string, ctx: ToolContext): boolean {
  const absN = normalizeRoot(abs);
  const homeCp = normalizeRoot(resolve(homedir(), ".codepilot"));
  if (absN === homeCp || absN.startsWith(homeCp + "/") || absN.startsWith(homeCp + "\\")) {
    return true;
  }
  for (const root of [ctx.scratchDir, ctx.projectStateDir]) {
    if (!root) continue;
    const r = normalizeRoot(root);
    if (absN === r || absN.startsWith(r + "/") || absN.startsWith(r + "\\")) return true;
  }
  return false;
}

/**
 * Keep intentional project writes inside the session's delivery roots
 * (defaults to cwd; extended from path tokens in user prompts). Distinct
 * from the OS sandbox: expanding writablePaths does not change delivery
 * roots. When the target is outside, ask the user (if possible) whether
 * to add that folder for this task; otherwise refuse with guidance.
 */
export async function guardDeliveryWrite(
  ctx: ToolContext,
  path: string,
): Promise<ToolResult | null> {
  const roots = ctx.deliveryRoots;
  if (!roots || roots.length === 0) return null;

  const abs = normalizeRoot(isAbsolute(path) ? path : resolve(ctx.cwd, path));
  if (isDeliveryExempt(abs, ctx)) return null;
  if (isUnderDeliveryRoots(abs, roots, ctx.cwd)) return null;

  const candidateDir = normalizeRoot(dirname(abs));
  const rootsList = roots.map((r) => `  - ${r}`).join("\n");

  if (ctx.askUser) {
    try {
      const allowLabel = "Allow this folder for this task";
      const answers = await ctx.askUser({
        requestId: `delivery_${Math.random().toString(36).slice(2, 10)}`,
        questions: [
          {
            id: "delivery_root",
            question:
              `Write target is outside this task's delivery roots:\n` +
              `${rootsList}\n\n` +
              `Target: ${abs}\n` +
              `Add “${candidateDir}” for this session?\n` +
              `Approval updates both delivery roots and the OS sandbox ` +
              `writable roots (one folder grant, both policies).`,
            options: [
              { label: allowLabel, description: candidateDir },
              { label: "Cancel — write under existing delivery roots" },
            ],
          },
        ],
      });
      const picked = answers?.delivery_root;
      const allow =
        picked === allowLabel ||
        (Array.isArray(picked) && picked.includes(allowLabel)) ||
        (typeof picked === "string" && /allow this folder/i.test(picked));
      if (allow) {
        if (ctx.addDeliveryRoot) {
          await ctx.addDeliveryRoot(candidateDir);
        } else if (ctx.deliveryRoots) {
          const merged = mergeDeliveryRoots(ctx.deliveryRoots, [candidateDir]);
          ctx.deliveryRoots.length = 0;
          ctx.deliveryRoots.push(...merged);
        }
        // Same grant must open the OS jail; delivery roots alone do not.
        if (ctx.expandSandboxWritable) {
          await ctx.expandSandboxWritable(candidateDir, { persist: false });
        }
        return null;
      }
    } catch {
      // Fall through to hard refuse if ask fails.
    }
  }

  return {
    content:
      `delivery_root: refusing write to ${abs}.\n` +
      `This task's delivery roots are:\n${rootsList}\n` +
      `Put intentional project deliverables under those roots ` +
      `(temp/runtime files go in scratch_dir). ` +
      `If the user meant a different folder, ask via ask_user_question ` +
      `whether to add it as a delivery root, then retry.`,
    isError: true,
  };
}
