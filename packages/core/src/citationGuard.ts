// citationGuard: flag file:line citations in the final answer that were
// never backed by a tool observation this session.
//
// The highest-frequency hallucination in analysis tasks is a fabricated
// `path/to/file.ts:123` reference — the model "remembers" a file it did not
// actually open (or opened a different one) and invents a line number. This
// guard is a cheap, non-blocking backstop: after the model produces its final
// text, extract every `path:line` citation and check whether that path was
// actually touched by a read/grep/glob/edit tool in this session. Citations to
// unseen paths get surfaced as a system notice so the model can verify or
// retract — they are never silently trusted, and the guard never blocks a turn
// (a false positive must not stall the user).
//
// This is deliberately heuristic: it checks path provenance (did we look at
// this file?), not line-number correctness (which would require re-reading).
// No peer agent ships even this much, so a conservative notice is a strict
// improvement.

import type { Event } from "./types.js";

/** A citation extracted from assistant prose. */
export interface Citation {
  /** The raw `path:line` (or `path:line-line`) text as written. */
  raw: string;
  /** The path portion, normalised to forward slashes. */
  path: string;
}

// path:line — the path is a run of path-ish chars ending in a file-looking
// segment (has a dot or a slash), followed by :<digits> (optionally a range).
// Anchored loosely so it catches `src/a.ts:12`, `./a.ts:12-30`, `pkg/b.rs:9`.
const CITATION_RE =
  /(?<![\w/.-])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[\w]+):(\d+)(?:-\d+)?/g;

/** Extract `path:line` citations from assistant text. */
export function extractCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_RE)) {
    const raw = m[0];
    const path = m[1]!.replace(/\\/g, "/").replace(/^\.\//, "");
    const key = `${path}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, path });
  }
  return out;
}

/** Paths the session actually observed via a read/search/edit tool. */
export function observedPaths(events: Event[]): Set<string> {
  const paths = new Set<string>();
  const add = (p: unknown): void => {
    if (typeof p === "string" && p.trim() !== "") {
      paths.add(p.replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  };
  for (const e of events) {
    if (e.type !== "tool_call") continue;
    const input = (e.input ?? {}) as Record<string, unknown>;
    switch (e.name) {
      case "read_file":
      case "write_file":
      case "edit_file":
      case "read_image":
      case "notebook_edit":
      case "lsp_navigate":
        add(input.path);
        add(input.file_path);
        break;
      case "apply_patch":
        // Paths live in the patch body; extract the headers.
        if (typeof input.patch === "string") {
          for (const line of input.patch.split(/\r?\n/)) {
            for (const prefix of [
              "*** Add File: ",
              "*** Update File: ",
              "*** Delete File: ",
            ]) {
              if (line.startsWith(prefix)) add(line.slice(prefix.length).trim());
            }
          }
        }
        break;
      case "grep":
      case "glob":
      case "ls":
        // These establish that a directory/pattern was searched; we treat any
        // path under a searched location as plausibly seen. Record the search
        // root/pattern so suffix matching below can clear nested citations.
        add(input.path);
        add(input.pattern);
        break;
      default:
        break;
    }
  }
  return paths;
}

export interface CitationCheck {
  /** Citations whose path we have no evidence of observing this session. */
  unverified: Citation[];
}

/** Return citations whose path was not observed by any tool this session. */
export function checkCitations(
  finalText: string,
  events: Event[],
): CitationCheck {
  const cites = extractCitations(finalText);
  if (cites.length === 0) return { unverified: [] };
  const observed = observedPaths(events);
  const unverified: Citation[] = [];
  for (const c of cites) {
    if (isObserved(c.path, observed)) continue;
    unverified.push(c);
  }
  return { unverified };
}

/** A citation is verified if its path equals, is a suffix of, or lives under
 * any observed path/pattern (handles relative vs absolute and search roots). */
function isObserved(citePath: string, observed: Set<string>): boolean {
  for (const o of observed) {
    if (o === citePath) return true;
    if (o.endsWith("/" + citePath) || citePath.endsWith("/" + o)) return true;
    // Citation under a searched directory/glob root.
    const base = o.replace(/\/?\*+.*$/, "");
    if (base && citePath.startsWith(base + "/")) return true;
    // Shared basename (model wrote a relative path to a file we opened absolute).
    const ob = o.split("/").pop();
    const cb = citePath.split("/").pop();
    if (ob && ob === cb && (o.includes("/") === false || citePath.includes("/") === false)) {
      return true;
    }
  }
  return false;
}

/** Build the system-notice body for unverified citations, or null if none. */
export function buildCitationNotice(check: CitationCheck): string | null {
  if (check.unverified.length === 0) return null;
  const list = check.unverified
    .slice(0, 12)
    .map((c) => `  - ${c.raw}`)
    .join("\n");
  const more =
    check.unverified.length > 12
      ? `\n  …and ${check.unverified.length - 12} more`
      : "";
  return (
    `The following file:line citations in your last answer were NOT backed by any ` +
    `read_file/grep/glob/edit in this session — you may have fabricated the path or line:\n` +
    `${list}${more}\n` +
    `For each: either open the file with read_file to confirm the exact location, ` +
    `or remove/soften the citation and say the reference is unverified. ` +
    `Do not restate an unconfirmed path:line as fact.`
  );
}
