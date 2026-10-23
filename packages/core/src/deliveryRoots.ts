// Task delivery roots: where intentional project deliverables should land.
//
// Distinct from sandbox writable roots (OS jail). Expanding the sandbox so a
// path is writable does NOT change the delivery root — the user-named target
// remains the preferred place for source/deliverables.
//
// Generic: any absolute / home / drive / relative path-like token in user text
// can extend the set. Defaults to the session cwd.

import { homedir } from "node:os";
import { dirname, extname, isAbsolute, resolve } from "node:path";

// Absolute / ~/ paths. Allow a colon before the path so Chinese prompts like
// `目录在:/Users/…/testnn` (no space after `:`) still count — otherwise the
 // session keeps delivery_roots=cwd and every write to the named dir re-asks
 // "Allow this folder". Reject `://` so `https://…` is not treated as a path.
const ABS_OR_HOME =
  /(?:^|[\s"'`(：]|:(?=\/[^/]))((?:~\/|\/|[A-Za-z]:[\\/])[^\s"'`()<>|,;]+)/g;
/** Relative paths with at least one slash (src/foo.ts, web/test/, ../pkg). */
const REL_PATH =
  /(?:^|[\s"'`(])((?:\.\.?\/|(?:[\w.-]+\/)+)[\w./\\-]+)/g;

/** Normalize for membership tests (no trailing slash except drive roots). */
export function normalizeRoot(p: string): string {
  let n = resolve(p);
  if (n.length > 1 && (n.endsWith("/") || n.endsWith("\\"))) {
    n = n.replace(/[/\\]+$/, "");
  }
  return n;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || s.startsWith("//");
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?）)」】\]]+$/g, "");
}

/**
 * Turn a path token into a delivery *directory* root: files → dirname,
 * directories (no extension / trailing slash) → themselves.
 */
export function rootFromPathToken(token: string, cwd: string): string | null {
  let raw = stripTrailingPunct(token.trim());
  if (!raw || looksLikeUrl(raw)) return null;
  if (raw.startsWith("~/")) raw = resolve(homedir(), raw.slice(2));
  else if (!isAbsolute(raw)) raw = resolve(cwd, raw);
  else raw = resolve(raw);

  const trailingSep = /[/\\]$/.test(token.trim());
  const ext = extname(raw);
  // Treat extension-less paths and trailing-slash tokens as directories.
  if (trailingSep || !ext) return normalizeRoot(raw);
  return normalizeRoot(dirname(raw));
}

/** Extract delivery directory roots mentioned in free-form user text. */
export function extractDeliveryRootsFromText(text: string, cwd: string): string[] {
  const found = new Set<string>();
  const add = (token: string) => {
    const r = rootFromPathToken(token, cwd);
    if (r) found.add(r);
  };
  for (const re of [ABS_OR_HOME, REL_PATH]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      add(m[1]!);
    }
  }
  return [...found];
}

/** True when `target` resolves under any delivery root (or equals one). */
export function isUnderDeliveryRoots(
  target: string,
  roots: readonly string[],
  cwd: string,
): boolean {
  if (roots.length === 0) return true;
  const abs = normalizeRoot(isAbsolute(target) ? target : resolve(cwd, target));
  for (const root of roots) {
    const r = normalizeRoot(root);
    if (abs === r || abs.startsWith(r + "/") || abs.startsWith(r + "\\")) {
      return true;
    }
  }
  return false;
}

/** Merge new roots into an existing list (normalized, de-duped). */
export function mergeDeliveryRoots(
  existing: readonly string[],
  extras: readonly string[],
): string[] {
  const out = new Set(existing.map(normalizeRoot));
  for (const e of extras) out.add(normalizeRoot(e));
  return [...out];
}

export function formatDeliveryRoots(roots: readonly string[]): string {
  if (roots.length === 0) return "(none — defaulting to cwd)";
  return roots.map((r) => `  - ${r}`).join("\n");
}
