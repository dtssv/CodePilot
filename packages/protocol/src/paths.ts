/**
 * Shared path-reference parsing — the single source of truth for turning a
 * string that appears in assistant text (or a tool result) into something a
 * client can open.
 *
 * The important case this centralises is the `path:line[:col]` anchor. That is
 * the exact form grep emits (`grep.ts` renders `file:line: snippet`) and the
 * form the system prompt tells the model to cite (`src/foo.ts:42`). Clients and
 * the `workspace/resolve` handler used to pass that whole string — colon,
 * digits and all — straight into a filesystem resolve, which always produced a
 * non-existent path, so a link that rendered as "openable" would not open.
 *
 * Keeping this here (in the dependency-light protocol surface, with no Node
 * `fs`/`path` imports) means the server resolver and every client surface
 * (web, VSCode, IntelliJ, Electron) parse the anchor identically.
 */

export interface ParsedReference {
  /** The path with any `:line[:col]` anchor stripped. */
  path: string;
  /** 1-based line number parsed from the anchor, if present. */
  line?: number;
  /** 1-based column parsed from the anchor, if present. */
  column?: number;
}

// A trailing `:<line>` or `:<line>:<col>` anchor. Anchored to end of string so
// it never eats a colon that is part of the path itself (e.g. a Windows drive
// letter `C:\…` or a `scheme:` prefix, both handled before we get here).
const LINE_ANCHOR_RE = /:(\d{1,9})(?::(\d{1,9}))?$/;

/**
 * Split a reference string into its path and optional line/column anchor.
 * Never throws; a string with no anchor comes back as `{ path: trimmed }`.
 *
 * Only strips the anchor when what precedes it still looks like a path (has a
 * separator or a file extension), so a bare `3:14` or `localhost:8080` is left
 * untouched.
 */
export function parseReference(raw: string): ParsedReference {
  const s = raw.trim();
  const m = LINE_ANCHOR_RE.exec(s);
  if (!m) return { path: s };
  const candidate = s.slice(0, m.index);
  // Guard: only treat the suffix as a line anchor when the head is path-like.
  // Otherwise `8080` in `localhost:8080` or a lone `12:34` would be mis-split.
  if (!hasPathShape(candidate)) return { path: s };
  const line = Number(m[1]);
  const column = m[2] !== undefined ? Number(m[2]) : undefined;
  const out: ParsedReference = { path: candidate };
  if (Number.isFinite(line) && line > 0) out.line = line;
  if (column !== undefined && Number.isFinite(column) && column > 0) out.column = column;
  return out;
}

/** Does `s` have a path separator or a file extension? (anchor-free check) */
function hasPathShape(s: string): boolean {
  if (!s) return false;
  if (s.includes("/") || s.includes("\\")) return true;
  return /\.[a-z0-9]{1,16}$/i.test(s);
}

/**
 * Heuristic: does this string (possibly carrying a `:line[:col]` anchor) look
 * like a workspace file path worth rendering as an openable link? Mirrors the
 * old web-only `looksLikeWorkspacePath`, but anchor-aware so grep's standard
 * `src/foo.ts:42` output is recognised.
 */
export function looksLikeWorkspacePath(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 260) return false;
  if (/\s/.test(s) || s.includes("\n") || s.includes("\0")) return false;
  if (/^(https?|mailto|data):/i.test(s)) return false;
  if (/^[a-z0-9+-]+:\/\//i.test(s)) return false;
  // Bare tool names / flags.
  if (/^-+/.test(s)) return false;
  // Judge path-shape on the anchor-stripped head so `src/foo.ts:42` counts.
  return hasPathShape(parseReference(s).path);
}
