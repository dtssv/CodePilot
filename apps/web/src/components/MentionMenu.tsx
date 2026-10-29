// Reusable `/` (slash command) + `@` (mention) autocomplete menu for the
// composer. UI-only + keyboard nav; all candidates come from the server via
// callbacks the parent wires to the protocol client (commandsList /
// workspaceComplete). Mirrors the mainstream design (codex/opencode/dsh):
// the server computes ranked candidates, the client just renders and inserts
// a plain token the agent resolves at prompt time.

import React, { useEffect, useRef, useState } from "react";

export type CompletionKind = "file" | "dir" | "mcp" | "git" | "skill";

export interface MentionCandidate {
  kind: CompletionKind;
  value: string;
  label: string;
  detail?: string;
}

export interface CommandCandidate {
  name: string;
  description: string;
  argumentHint?: string;
  source: "builtin" | "project" | "user";
}

export interface MenuProvider {
  listCommands(): Promise<CommandCandidate[]>;
  /** Fetch candidates for one chosen category. */
  complete(query: string, kind: CompletionKind): Promise<MentionCandidate[]>;
}

/** Category rows shown when the user typed `@` but hasn't chosen a kind yet. */
const AT_CATEGORIES: Array<{ kind: CompletionKind; label: string; detail: string }> = [
  { kind: "file", label: "Files", detail: "reference a file" },
  { kind: "dir", label: "Folders", detail: "reference a directory" },
  { kind: "git", label: "Git", detail: "a changed file" },
  { kind: "mcp", label: "MCP", detail: "an MCP resource" },
  { kind: "skill", label: "Skills", detail: "a skill" },
];

/** The active trigger detected in the textarea, or null. */
export interface Trigger {
  kind: "slash" | "at";
  /** Query text after the trigger char (up to the caret). For `at` triggers
   * this is the text AFTER any `kind:` prefix. */
  query: string;
  /** For `at` triggers: the chosen category (file/dir/mcp/git/skill), or null
   * when the user hasn't picked one yet (→ show the category menu first). */
  atKind: CompletionKind | null;
  /** Index of the trigger char in the full text. */
  start: number;
  /** Caret index (end of the query). */
  end: number;
}

/**
 * Detect a `/` or `@` trigger at the caret. `/` only triggers when it starts
 * the whole input (slash commands are line-leading, like every harness).
 * `@` triggers anywhere a whitespace/BOL precedes it. The query runs from the
 * trigger char to the caret and must not contain whitespace.
 */
const AT_KINDS: CompletionKind[] = ["file", "dir", "mcp", "git", "skill"];

export function detectTrigger(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null;
  // Slash: only at the very start of the input.
  if (text.startsWith("/") && caret > 0) {
    const q = text.slice(1, caret);
    if (!/\s/.test(q)) return { kind: "slash", query: q, atKind: null, start: 0, end: caret };
  }
  // At-mention: scan back from caret to the `@`.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === "@") {
      const before = i === 0 ? "" : text[i - 1]!;
      if (i === 0 || /\s/.test(before)) {
        const raw = text.slice(i + 1, caret);
        if (/\s/.test(raw)) return null;
        // `@kind:query` → category chosen; `@query` → category menu (atKind null).
        const m = /^([a-z]+):([\s\S]*)$/.exec(raw);
        if (m && (AT_KINDS as string[]).includes(m[1]!)) {
          return { kind: "at", atKind: m[1] as CompletionKind, query: m[2]!, start: i, end: caret };
        }
        return { kind: "at", atKind: null, query: raw, start: i, end: caret };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

interface Row {
  insert: string;
  primary: string;
  secondary?: string;
  badge?: string;
  /** Category rows keep the menu open (they only narrow the kind). */
  keepOpen?: boolean;
}

const KIND_BADGE: Record<CompletionKind, string> = {
  file: "file",
  dir: "dir",
  mcp: "mcp",
  git: "git",
  skill: "skill",
};

export interface MentionMenuProps {
  trigger: Trigger | null;
  provider: MenuProvider;
  /** Called when a row is picked. `keepOpen` stays in the menu (category pick). */
  onPick(replacement: { insert: string; keepOpen?: boolean }): void;
  /** Called when the menu wants to close (Esc / no trigger). */
  onClose(): void;
}

/**
 * Renders the popup when a trigger is active. The parent owns caret/text; this
 * component only fetches candidates for the current trigger and reports the
 * chosen token back via onPick. Keyboard: ↑/↓ move, Enter/Tab pick, Esc close
 * — handled here via a ref the parent calls (see useMentionKeys).
 */
export function MentionMenu({ trigger, provider, onPick, onClose }: MentionMenuProps): React.ReactElement | null {
  const [rows, setRows] = useState<Row[]>([]);
  const [active, setActive] = useState(0);
  const reqId = useRef(0);

  useEffect(() => {
    if (!trigger) {
      setRows([]);
      return;
    }
    const id = ++reqId.current;
    const run = async (): Promise<void> => {
      try {
        if (trigger.kind === "slash") {
          const cmds = await provider.listCommands();
          const q = trigger.query.toLowerCase();
          const filtered = cmds
            .filter((c) => !q || c.name.toLowerCase().includes(q))
            .slice(0, 50)
            .map<Row>((c) => ({
              insert: `/${c.name} `,
              primary: `/${c.name}`,
              secondary: c.description,
              badge: c.source === "builtin" ? undefined : c.source,
            }));
          if (id === reqId.current) setRows(filtered);
        } else if (trigger.atKind === null) {
          // Category menu: user typed `@` (optionally a few chars). Show the
          // categories, filtered by what they've typed. Picking one inserts
          // `@kind:` so the next keystrokes query that category.
          const q = trigger.query.toLowerCase();
          const cats = AT_CATEGORIES.filter(
            (c) => !q || c.kind.startsWith(q) || c.label.toLowerCase().startsWith(q),
          ).map<Row>((c) => ({
            insert: `@${c.kind}:`,
            primary: c.label,
            secondary: c.detail,
            badge: c.kind,
            keepOpen: true,
          }));
          if (id === reqId.current) setRows(cats);
        } else {
          const cands = await provider.complete(trigger.query, trigger.atKind);
          const mapped = cands.slice(0, 50).map<Row>((c) => ({
            insert: `@${c.value} `,
            primary: c.label,
            secondary: c.detail,
            badge: KIND_BADGE[c.kind],
          }));
          if (id === reqId.current) setRows(mapped);
        }
        if (id === reqId.current) setActive(0);
      } catch {
        if (id === reqId.current) setRows([]);
      }
    };
    void run();
  }, [trigger, provider]);

  // Expose keyboard handling to the parent textarea via a window-less ref
  // pattern: parent calls handleKey(e) in its onKeyDown before its own logic.
  (MentionMenu as unknown as { _activeHandler?: (e: KeyboardEvent | React.KeyboardEvent) => boolean })._activeHandler =
    (e) => {
      if (!trigger || rows.length === 0) return false;
      if (e.key === "ArrowDown") { setActive((a) => (a + 1) % rows.length); return true; }
      if (e.key === "ArrowUp") { setActive((a) => (a - 1 + rows.length) % rows.length); return true; }
      if (e.key === "Enter" || e.key === "Tab") {
        const row = rows[active];
        if (row) { onPick({ insert: row.insert, keepOpen: row.keepOpen }); return true; }
      }
      if (e.key === "Escape") { onClose(); return true; }
      return false;
    };

  if (!trigger || rows.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-64 overflow-auto rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] py-1 shadow-lg"
      role="listbox"
    >
      {rows.map((r, i) => (
        <button
          key={r.insert}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => { e.preventDefault(); onPick({ insert: r.insert, keepOpen: r.keepOpen }); }}
          onMouseEnter={() => setActive(i)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
            i === active ? "bg-[var(--color-surface-sunken)]" : ""
          }`}
        >
          <span className="truncate font-medium text-[var(--color-ink)]">{r.primary}</span>
          {r.badge && (
            <span className="shrink-0 rounded bg-[var(--color-surface-sunken)] px-1 text-[10px] text-[var(--color-ink-dim)]">
              {r.badge}
            </span>
          )}
          {r.secondary && (
            <span className="ml-auto truncate text-[11px] text-[var(--color-ink-faint)]">{r.secondary}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Returns a keydown handler the textarea calls first; returns true if the
 * menu consumed the key (so the parent skips its own Enter/Esc handling). */
export function mentionMenuHandleKey(e: React.KeyboardEvent): boolean {
  const h = (MentionMenu as unknown as { _activeHandler?: (e: React.KeyboardEvent) => boolean })._activeHandler;
  return h ? h(e) : false;
}

/** Apply a picked token: replace [trigger.start, trigger.end) with `insert`. */
export function applyPick(text: string, trigger: Trigger, insert: string): { text: string; caret: number } {
  const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
  return { text: next, caret: trigger.start + insert.length };
}
