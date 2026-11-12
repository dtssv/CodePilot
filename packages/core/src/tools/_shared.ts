// Shared helpers for built-in tools: sandbox path guard + ignore lists.

import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { assertPathAllowed, assertPathAllowedAsync } from "../sandbox.js";
import { hashFileContent } from "../fsObservation.js";
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
 * Relative path prefixes (from the search root) to skip when the leaf
 * directory name alone isn't enough — e.g. `.codepilot/artifacts` never
 * appears as a single basename, so name-only ignore would silently fail.
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
 * @param relPath entry path relative to the search root (`/` separators).
 * @param name the entry's basename (`ent.name`).
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

/** Shared threshold for spilling large tool output to an artifact. Above this
 * many characters, a tool keeps a bounded inline view and stashes the full body
 * via {@link ToolContext.artifact}. Single-sourced so several tools enforce the
 * same budget consistently. */
export const ARTIFACT_THRESHOLD = 8_000;

/** Default head/tail window for {@link spillHeadTail}. */
const DEFAULT_SPILL_HEAD = 4_000;
const DEFAULT_SPILL_TAIL = 4_000;

/**
 * Spill `content` to an artifact and return a bounded head+tail inline view
 * with a gap marker. Use when both ends carry signal (e.g. a command's first
 * lines AND its exit status). Unchanged at or below the threshold.
 */
export async function spillHeadTail(
  ctx: ToolContext,
  content: string,
  hint: string,
  opts: { head?: number; tail?: number } = {}
): Promise<{ content: string; artifactRef?: string }> {
  if (content.length <= ARTIFACT_THRESHOLD) return { content };
  const head = opts.head ?? DEFAULT_SPILL_HEAD;
  const tail = opts.tail ?? DEFAULT_SPILL_TAIL;
  const artifactRef = await ctx.artifact(content, hint);
  const omitted = content.length - head - tail;
  // Degenerate guard: if head+tail would cover (or overlap) the whole body,
  // just return it verbatim with the ref — slicing would duplicate content.
  if (omitted <= 0) return { content, artifactRef };
  const view =
    content.slice(0, head) +
    `\n\n[... ${omitted.toLocaleString()} chars omitted; full output in artifact ${artifactRef} — ` +
    `use read_artifact with startLine/maxLines for any slice ...]\n\n` +
    content.slice(content.length - tail);
  return { content: view, artifactRef };
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
 * Keep intentional writes inside delivery roots. If the OS sandbox already
 * allows the write, silently extend delivery roots; otherwise ask to add the
 * folder, or refuse.
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

  // Sandbox already writable → treat as an implied delivery grant.
  const sb = ctx.sandbox;
  if (
    sb &&
    sb.mode !== "off" &&
    sb.mode !== "read-only" &&
    assertPathAllowed(abs, "write", sb, ctx.cwd).ok
  ) {
    await adoptDeliveryRoot(ctx, roots, candidateDir);
    return null;
  }

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
        await adoptDeliveryRoot(ctx, roots, candidateDir);
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

/** Extend session delivery roots (via callback or in-place mutate). */
async function adoptDeliveryRoot(
  ctx: ToolContext,
  roots: string[],
  dir: string,
): Promise<void> {
  if (ctx.addDeliveryRoot) {
    await ctx.addDeliveryRoot(dir);
    return;
  }
  const merged = mergeDeliveryRoots(roots, [dir]);
  roots.length = 0;
  roots.push(...merged);
}

/**
 * Read-before-write + staleness guard for a write/edit target: null to proceed
 * or an error ToolResult. `currentStat` (null = create); `currentContent`/
 * `readCurrent` enable the content-equality fallback for a jittered mtime.
 */
export async function guardFreshWrite(
  ctx: ToolContext,
  absPath: string,
  currentStat: { mtimeMs: number; size: number } | null,
  currentContent?: Buffer | string,
  readCurrent?: () => Promise<Buffer | string | null>,
): Promise<ToolResult | null> {
  if (!ctx.checkFileFresh) return null;
  const toHash = (c: Buffer | string): string =>
    hashFileContent(Buffer.isBuffer(c) ? c : Buffer.from(c, "utf-8"));
  const eagerHash = currentContent === undefined ? undefined : toHash(currentContent);
  const res = ctx.checkFileFresh(absPath, currentStat, eagerHash);
  if (res.ok) return null;
  // Only a stale verdict on an existing file can be rescued by content equality.
  // Lazily read the current bytes (if a reader was supplied) and re-check.
  if (res.reason === "stale" && eagerHash === undefined && readCurrent) {
    try {
      const bytes = await readCurrent();
      if (bytes !== null) {
        const retry = ctx.checkFileFresh(absPath, currentStat, toHash(bytes));
        if (retry.ok) return null;
      }
    } catch {
      /* fall through to the stale error */
    }
  }
  return { content: res.message, isError: true };
}
