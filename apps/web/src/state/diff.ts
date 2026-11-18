// Turning a file-mutating tool call into something reviewable. The protocol
// carries the tool *inputs* (`write_file` → full content, `edit_file` →
// search/replace pairs), not diffs, so we derive the view model from those
// inputs. For `edit_file` we show the exact search/replace text submitted; for
// `write_file` the whole file as an insertion.

export type DiffLineKind = "add" | "remove" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
 /** Shown above the hunk, e.g. "edit 2 of 3" or "new content". */
  label?: string;
  lines: DiffLine[];
}

export interface FileChange {
  path: string;
 /** What the tool call does to the file. */
  operation: "write" | "edit" | "patch";
  hunks: DiffHunk[];
 /** Counts for the summary badge. */
  added: number;
  removed: number;
 /** Set when the change is too large to render in full. */
  truncated?: boolean;
}

/** Cap on rendered lines per hunk — a 5k-line file must not freeze the tab. */
const MAX_LINES_PER_HUNK = 400;

const WRITE_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "notebook_edit"]);

export function isFileMutation(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/**
 * Build the change view model for a tool call, or null when the call is not a
 * file mutation (or its input does not have the expected shape — a malformed
 * input should degrade to the raw JSON view, not throw).
 */
export function fileChangeFromToolCall(
  toolName: string,
  input: unknown,
): FileChange | null {
  if (!isFileMutation(toolName)) return null;
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;

  if (toolName === "apply_patch" && typeof o.patch === "string") {
    return fileChangeFromApplyPatch(o.patch);
  }

  const path = firstString(o, ["path", "file_path", "filePath", "notebook_path"]);
  if (!path) return null;

  if (toolName === "write_file") {
    const content = typeof o.content === "string" ? o.content : "";
    const { lines, truncated } = toLines(content, "add");
    return {
      path,
      operation: "write",
      hunks: [{ label: "new content", lines }],
      added: countKind(lines, "add"),
      removed: 0,
      truncated,
    };
  }

  if (toolName === "edit_file") {
    const edits = readEdits(o);
    if (edits.length === 0) return null;
    const hunks: DiffHunk[] = [];
    let added = 0;
    let removed = 0;
    let truncated = false;
    edits.forEach((edit, i) => {
      const before = toLines(edit.search, "remove");
      const after = toLines(edit.replace, "add");
      truncated = truncated || before.truncated || after.truncated;
      removed += countKind(before.lines, "remove");
      added += countKind(after.lines, "add");
      const label =
        edits.length > 1 ? `edit ${i + 1} of ${edits.length}` : undefined;
      const lines: DiffLine[] = [...before.lines, ...after.lines];
      if (edit.global_replace || edit.regex) {
        lines.unshift({
          kind: "meta",
          text: [
            edit.global_replace ? "every occurrence" : null,
            edit.regex ? "regex search" : null,
          ]
            .filter(Boolean)
            .join(", "),
        });
      }
      hunks.push({ label, lines });
    });
    return { path, operation: "edit", hunks, added, removed, truncated };
  }

 // notebook_edit (and any other mutate tool with a bare path): path alone.
  return {
    path,
    operation: "patch",
    hunks: [],
    added: 0,
    removed: 0,
  };
}

/** Build a reviewable change from an apply_patch body (files + +/- lines). */
function fileChangeFromApplyPatch(patch: string): FileChange | null {
  const touches: Array<{ op: "add" | "update" | "delete"; path: string }> = [];
  for (const line of patch.split(/\r?\n/)) {
    for (const [prefix, op] of [
      ["*** Add File: ", "add"],
      ["*** Update File: ", "update"],
      ["*** Delete File: ", "delete"],
    ] as const) {
      if (line.startsWith(prefix)) {
        const p = line.slice(prefix.length).trim();
        if (p) touches.push({ op, path: p });
        break;
      }
    }
  }
  if (touches.length === 0) return null;

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line === "*** Begin Patch" || line === "*** End Patch" || line === "*** End of File") continue;
    if (line.startsWith("*** ")) {
      lines.push({ kind: "meta", text: line.slice(4) });
      continue;
    }
    if (line.startsWith("@@")) {
      lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
      if (lines.length < MAX_LINES_PER_HUNK) lines.push({ kind: "add", text: line.slice(1) });
      else truncated = true;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
      if (lines.length < MAX_LINES_PER_HUNK) lines.push({ kind: "remove", text: line.slice(1) });
      else truncated = true;
      continue;
    }
    if (line.startsWith(" ")) {
      if (lines.length < MAX_LINES_PER_HUNK) lines.push({ kind: "context", text: line.slice(1) });
      else truncated = true;
    }
  }
  if (truncated) {
    lines.push({ kind: "meta", text: `… remaining patch lines not shown` });
  }

  const path =
    touches.length === 1
      ? touches[0]!.path
      : touches.map((t) => (t.op === "add" ? `+${t.path}` : t.op === "delete" ? `−${t.path}` : t.path)).join(", ");
  const allAdd = touches.every((t) => t.op === "add");
  return {
    path,
    operation: allAdd ? "write" : "patch",
    hunks: lines.length ? [{ label: touches.length === 1 ? undefined : `${touches.length} files`, lines }] : [],
    added,
    removed,
    truncated: truncated || undefined,
  };
}

interface EditSpec {
  search: string;
  replace: string;
  global_replace?: boolean;
  regex?: boolean;
}

function readEdits(o: Record<string, unknown>): EditSpec[] {
  if (Array.isArray(o.edits)) {
    return o.edits
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((e) => ({
        search: typeof e.search === "string" ? e.search : "",
        replace: typeof e.replace === "string" ? e.replace : "",
        global_replace: e.global_replace === true,
        regex: e.regex === true,
      }))
      .filter((e) => e.search !== "" || e.replace !== "");
  }
  if (typeof o.search === "string") {
    return [
      {
        search: o.search,
        replace: typeof o.replace === "string" ? o.replace : "",
        global_replace: o.global_replace === true,
        regex: o.regex === true,
      },
    ];
  }
  return [];
}

function toLines(
  text: string,
  kind: DiffLineKind,
): { lines: DiffLine[]; truncated: boolean } {
  if (text === "") return { lines: [], truncated: false };
  const all = text.split("\n");
  const kept = all.slice(0, MAX_LINES_PER_HUNK);
  const lines: DiffLine[] = kept.map((text) => ({ kind, text }));
  if (all.length > kept.length) {
    lines.push({
      kind: "meta",
      text: `… ${all.length - kept.length} more line(s) not shown`,
    });
    return { lines, truncated: true };
  }
  return { lines, truncated: false };
}

function countKind(lines: DiffLine[], kind: DiffLineKind): number {
  return lines.filter((l) => l.kind === kind).length;
}

function firstString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}
