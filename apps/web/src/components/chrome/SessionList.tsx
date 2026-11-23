import { useMemo, useState } from "react";

import type { SessionSummary } from "@codepilot/core";

import { dateBucket, type DateBucket } from "../../state/selectors.js";
import { t } from "../../i18n.js";
import { ChatIcon, SearchIcon } from "../Icons.js";

export const DEFAULT_SESSION_PREVIEW = 5;
export const SESSION_PAGE_SIZE = 10;

export function SessionList({
  sessions,
  activeId,
  onResume,
  emptyText,
  icon,
}: {
  sessions: SessionSummary[];
  activeId?: string;
  onResume(id: string): void;
  emptyText: string;
  icon?: React.ReactNode;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sessions
      .filter((s) => !q || (s.title || s.id).toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const out: Array<{ bucket: DateBucket; items: SessionSummary[] }> = [];
    for (const s of filtered) {
      const bucket = dateBucket(s.updatedAt);
      const last = out[out.length - 1];
      if (last && last.bucket === bucket) last.items.push(s);
      else out.push({ bucket, items: [s] });
    }
    return out;
  }, [sessions, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sessions.length > 6 && (
        <label className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5">
          <SearchIcon className="h-3.5 w-3.5 text-[var(--color-ink-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search…")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
          />
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {sessions.length === 0 && <div className="px-2 py-3 text-[12px] text-[var(--color-ink-faint)]">{emptyText}</div>}
        {groups.map((g) => (
          <div key={g.bucket} className="mb-2">
            <div className="cp-eyebrow px-2 pt-2 pb-1">{t(g.bucket)}</div>
            {g.items.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onResume(s.id)}
                title={`${s.title || s.id}\n${s.cwd}`}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  s.id === activeId
                    ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]"
                    : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                }`}
              >
                <span className="shrink-0 text-[var(--color-ink-faint)]">{icon ?? <ChatIcon className="h-3.5 w-3.5" />}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title || s.id}</span>
                <span className="shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">{shortTime(s.updatedAt)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One session row in the workspace nav, with a hover ··· menu for
 * pin/archive. Pinned rows show a ★ marker. Right-click opens the same actions. */
export function SessionRow({
  s,
  active,
  sessionIcon,
  menuOpen,
  onToggleMenu,
  onResume,
  onPin,
  onArchive,
  onUnarchive,
  onContextMenu,
}: {
  s: SessionSummary;
  ws: string;
  active: boolean;
  sessionIcon?: React.ReactNode;
  menuOpen: boolean;
  onToggleMenu(): void;
  onResume(): void;
  onPin?(): void;
  onArchive?(): void;
  onUnarchive?(): void;
  onContextMenu?(e: React.MouseEvent): void;
}): React.ReactElement {
  const hasMenu = !!(onPin || onArchive || onUnarchive);
  return (
    <div
      className={`group/row relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
        active
          ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]"
          : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
      }`}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={onResume}
        title={`${s.title || s.id}\n${s.cwd}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="shrink-0 text-[var(--color-ink-faint)]">
          {s.pinned ? <span className="text-[var(--color-accent)]">★</span> : (sessionIcon ?? <ChatIcon className="h-3.5 w-3.5" />)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px]">{s.title || s.id}</span>
      </button>
      {hasMenu && (
        <div className="relative shrink-0">
          <button
            type="button"
            className={`cp-icon-btn ${menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"}`}
            title={t("More")}
            aria-label={t("More")}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMenu();
            }}
          >
            <span className="text-[13px] leading-none">⋯</span>
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 z-20 mt-1 min-w-[132px] rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
              role="menu"
            >
              {onPin && (
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                  onClick={(e) => { e.stopPropagation(); onPin(); }}
                >
                  {s.pinned ? t("Unpin") : t("Pin")}
                </button>
              )}
              {onArchive && (
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                  onClick={(e) => { e.stopPropagation(); onArchive(); }}
                >
                  {t("Archive")}
                </button>
              )}
              {onUnarchive && (
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                  onClick={(e) => { e.stopPropagation(); onUnarchive(); }}
                >
                  {t("Unarchive")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {/* Timestamp is always shown; the ··· menu sits to its left on hover. */}
      <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">{shortTime(s.updatedAt)}</span>
    </div>
  );
}

function shortTime(ts: number): string {
  const d = new Date(ts);
  if (dateBucket(ts) === "Today") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}