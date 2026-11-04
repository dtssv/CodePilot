// Global command palette (⌘K / Ctrl+K).
//
// A single fuzzy-searchable list over actions, open workspaces and saved
// sessions — the quick-jump entry point mainstream editors expose. It is a
// controlled overlay: the parent owns open/close and supplies the command
// list, so the palette stays presentational and testable.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { t } from "../i18n.js";

export interface PaletteCommand {
  id: string;
  /** Primary label shown in the list. */
  title: string;
  /** Optional dimmed context (e.g. a workspace path or group name). */
  hint?: string;
  /** Group heading used to cluster results. */
  group: string;
  /** Extra text matched by search but not displayed. */
  keywords?: string;
  run(): void;
}

/** Case-insensitive subsequence match with a light score (earlier = better). */
function fuzzyScore(haystack: string, needle: string): number | null {
  if (needle === "") return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    // Reward contiguous matches and matches near the start.
    streak = found === hi ? streak + 1 : 0;
    score += found - hi - streak;
    hi = found + 1;
  }
  return score;
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose(): void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const q = query.trim();
    const scored: Array<{ cmd: PaletteCommand; score: number }> = [];
    for (const cmd of commands) {
      const hay = `${cmd.title} ${cmd.hint ?? ""} ${cmd.keywords ?? ""} ${cmd.group}`;
      const score = fuzzyScore(hay, q);
      if (score !== null) scored.push({ cmd, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.cmd);
  }, [commands, query]);

  // Reset the highlight to the top whenever the result set changes.
  useEffect(() => {
    setActive(0);
  }, [results]);

  // Keep the active row visible as the user arrows through results.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (cmd: PaletteCommand | undefined): void => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // IME composition (Chinese/Japanese input) uses Enter/arrows to navigate
    // candidates; those keys must not drive the palette while composing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Render with group headings; the list is already sorted by score, so group
  // headings appear the first time a group is seen.
  const seen = new Set<string>();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Command palette")}
        className="flex max-h-[70vh] w-full max-w-xl animate-fade-in flex-col overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("Search commands, sessions, workspaces…")}
          aria-label={t("Command palette")}
          role="combobox"
          aria-expanded
          aria-controls="cp-palette-list"
          aria-activedescendant={results[active] ? `cp-palette-opt-${active}` : undefined}
          className="shrink-0 border-b border-[var(--color-edge-subtle)] bg-transparent px-4 py-3 text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
        <div ref={listRef} id="cp-palette-list" role="listbox" className="min-h-0 flex-1 overflow-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12.5px] text-[var(--color-ink-faint)]">{t("No matches")}</div>
          ) : (
            results.map((cmd, i) => {
              const showGroup = !seen.has(cmd.group);
              if (showGroup) seen.add(cmd.group);
              return (
                <div key={cmd.id}>
                  {showGroup && (
                    <div className="px-4 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">
                      {cmd.group}
                    </div>
                  )}
                  <button
                    type="button"
                    id={`cp-palette-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => run(cmd)}
                    className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] ${
                      i === active ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]" : "text-[var(--color-ink-dim)]"
                    }`}
                  >
                    <span className="truncate">{cmd.title}</span>
                    {cmd.hint && (
                      <span className="ml-auto truncate pl-3 font-mono text-[10.5px] text-[var(--color-ink-faint)]">{cmd.hint}</span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
