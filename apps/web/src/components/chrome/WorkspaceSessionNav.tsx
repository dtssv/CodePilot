import { useState } from "react";

import type { SessionSummary } from "@codepilot/core";

import { sameCwd } from "../../prefs.js";
import { t } from "../../i18n.js";
import { ChevronIcon, FolderIcon, PlusIcon, SearchIcon, XIcon } from "../Icons.js";
import { DEFAULT_SESSION_PREVIEW, SESSION_PAGE_SIZE, SessionRow } from "./SessionList.js";
import { SessionActions } from "./SessionActions.js";
import { NewButton } from "./NewButton.js";

/**
 * Nested sidebar: each workspace owns its session list underneath.
 * Default preview 5 sessions; "Show more" unlocks pages of up to 10.
 * Workspace order is stable — callers must not reorder on focus.
 */
export function WorkspaceSessionNav({
  workspaces,
  sessions,
  activeCwd,
  activeSessionId,
  connected,
  newLabel,
  emptyText,
  sessionIcon,
  canOpenNewWorkspace = true,
  onOpenWorkspace,
  onCloseWorkspace,
  onOpenNewWorkspace,
  onNewSession,
  onResumeSession,
  onPinSession,
  onArchiveSession,
  canFork,
  onFork,
  onRefresh,
}: {
  workspaces: string[];
  sessions: SessionSummary[];
  activeCwd?: string;
  activeSessionId?: string;
  connected: boolean;
  newLabel: string;
  emptyText: string;
  sessionIcon?: React.ReactNode;
  /** When false, hide “Open workspace…” (e.g. remote control). */
  canOpenNewWorkspace?: boolean;
  onOpenWorkspace(cwd: string): void;
  onCloseWorkspace(cwd: string): void;
  onOpenNewWorkspace(): void;
  onNewSession(): void;
  onResumeSession(id: string, cwd: string): void;
  /** Pin/unpin (one per workspace) and archive/unarchive a session. Optional:
   * omitted on surfaces that can't mutate (e.g. read-only remote). */
  onPinSession?(id: string, pinned: boolean): void;
  onArchiveSession?(id: string, archived: boolean): void;
  canFork: boolean;
  onFork(): void;
  onRefresh(): void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pageByWs, setPageByWs] = useState<Record<string, number>>({});
  // Per-workspace collapse of the whole session list (the row-head chevron).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Per-workspace "Archived" section expansion.
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  // Which session row's ··· menu is open (by session id).
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Keep the search bar visible while typing — never gate it on filtered count
  // (that used to unmount the input as soon as matches dropped ≤ 6).
  const showSearch = sessions.length > 6 || query.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-2 pt-1">
        <div className="cp-eyebrow flex-1">{t("Workspaces")}</div>
        <SessionActions canFork={canFork} canRefresh={connected} onFork={onFork} onRefresh={onRefresh} />
      </div>
      <div className="px-2 pb-2">
        <NewButton
          label={newLabel}
          onClick={onNewSession}
          disabled={!connected}
          title={activeCwd ? undefined : t("Select a workspace first")}
        />
      </div>
      {canOpenNewWorkspace && (
        <div className="px-2 pb-2">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
            onClick={onOpenNewWorkspace}
            disabled={!connected}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            {t("Open workspace…")}
          </button>
        </div>
      )}
      {showSearch && (
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
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
        {workspaces.length === 0 && (
          <div className="px-2 py-2 text-[11.5px] text-[var(--color-ink-faint)]">{t("No workspace yet")}</div>
        )}
        {workspaces.map((ws) => {
          const active = sameCwd(ws, activeCwd);
          const name = ws.split("/").filter(Boolean).pop() ?? ws;
          const q = query.trim().toLowerCase();
          const matched = sessions
            .filter((s) => sameCwd(s.cwd, ws))
            .filter((s) => !q || (s.title || s.id).toLowerCase().includes(q))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          // Partition: pinned (≤1 per workspace) first, then normal; archived
          // are pulled out into their own collapsible section.
          const archivedSessions = matched.filter((s) => s.archived);
          const liveSessions = matched.filter((s) => !s.archived);
          const pinnedSessions = liveSessions.filter((s) => s.pinned);
          const normalSessions = liveSessions.filter((s) => !s.pinned);
          // Non-archived count drives the list UI; pinned always shown on top.
          const wsSessions = [...pinnedSessions, ...normalSessions];
          const wsCollapsed = !!collapsed[ws];
          const isExpanded = !!expanded[ws];
          const page = pageByWs[ws] ?? 0;
          // Paging/preview applies to the NON-pinned rows; pinned are always on.
          const pageCount = Math.max(1, Math.ceil(normalSessions.length / SESSION_PAGE_SIZE));
          const safePage = Math.min(page, pageCount - 1);
          const normalVisible = isExpanded
            ? normalSessions.slice(safePage * SESSION_PAGE_SIZE, safePage * SESSION_PAGE_SIZE + SESSION_PAGE_SIZE)
            : normalSessions.slice(0, DEFAULT_SESSION_PREVIEW);
          const visible = [...pinnedSessions, ...normalVisible];
          const hasMore = !isExpanded && normalSessions.length > DEFAULT_SESSION_PREVIEW;
          const archivedOpen = !!showArchived[ws];

          return (
            <div
              key={ws}
              className={`rounded-xl border px-1.5 py-1.5 ${
                active
                  ? "border-[var(--color-edge)] bg-[var(--color-surface-raised)]"
                  : "border-transparent"
              }`}
            >
              <div
                className={`group flex items-center gap-0.5 rounded-lg px-1 py-0.5 ${
                  active ? "text-[var(--color-ink)]" : "text-[var(--color-ink-dim)]"
                }`}
              >
                <button
                  type="button"
                  className="cp-icon-btn shrink-0"
                  title={wsCollapsed ? t("Expand") : t("Collapse")}
                  aria-label={wsCollapsed ? t("Expand") : t("Collapse")}
                  onClick={() => setCollapsed((m) => ({ ...m, [ws]: !wsCollapsed }))}
                >
                  <ChevronIcon open={!wsCollapsed} className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-0.5 py-1 text-left"
                  title={ws}
                  onClick={() => onOpenWorkspace(ws)}
                  disabled={!connected}
                >
                  <FolderIcon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-[var(--color-accent)]" : ""}`} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{name}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">
                    {wsSessions.length}
                  </span>
                </button>
                <button
                  type="button"
                  className="cp-icon-btn shrink-0 opacity-0 group-hover:opacity-100"
                  title={t("Close workspace")}
                  onClick={() => onCloseWorkspace(ws)}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>

              {!wsCollapsed && (
                <>
                  {active && wsSessions.length === 0 && (
                    <div className="px-2 py-1.5 text-[11px] text-[var(--color-ink-faint)]">{emptyText}</div>
                  )}

                  <div className="space-y-0.5 pl-1">
                    {wsSessions.length === 0 && archivedSessions.length === 0 && !active && (
                      <div className="px-2 py-1.5 text-[11px] text-[var(--color-ink-faint)]">{emptyText}</div>
                    )}
                    {visible.map((s) => (
                      <SessionRow
                        key={s.id}
                        s={s}
                        ws={ws}
                        active={s.id === activeSessionId}
                        sessionIcon={sessionIcon}
                        menuOpen={menuFor === s.id}
                        onToggleMenu={() => setMenuFor((cur) => (cur === s.id ? null : s.id))}
                        onResume={() => {
                          setMenuFor(null);
                          onResumeSession(s.id, ws);
                        }}
                        onPin={onPinSession ? () => { setMenuFor(null); onPinSession(s.id, !s.pinned); } : undefined}
                        onArchive={onArchiveSession ? () => { setMenuFor(null); onArchiveSession(s.id, true); } : undefined}
                      />
                    ))}
                  </div>

                  {hasMore && (
                    <button
                      type="button"
                      className="mt-0.5 flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[11.5px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                      onClick={() => {
                        setExpanded((m) => ({ ...m, [ws]: true }));
                        setPageByWs((m) => ({ ...m, [ws]: 0 }));
                      }}
                    >
                      <ChevronIcon open={false} className="h-3 w-3" />
                      {t("Show more")}
                      <span className="text-[var(--color-ink-faint)]">({normalSessions.length - DEFAULT_SESSION_PREVIEW})</span>
                    </button>
                  )}

                  {isExpanded && normalSessions.length > DEFAULT_SESSION_PREVIEW && (
                    <div className="mt-0.5 space-y-0.5 px-1 py-0.5">
                      {pageCount > 1 && (
                        <div className="flex items-center justify-between gap-1">
                          <button
                            type="button"
                            className="cp-btn-ghost py-0.5 text-[11px]"
                            disabled={safePage <= 0}
                            onClick={() => setPageByWs((m) => ({ ...m, [ws]: Math.max(0, safePage - 1) }))}
                          >
                            {t("Previous")}
                          </button>
                          <button
                            type="button"
                            className="cp-btn-ghost py-0.5 text-[11px]"
                            disabled={safePage >= pageCount - 1}
                            onClick={() =>
                              setPageByWs((m) => ({ ...m, [ws]: Math.min(pageCount - 1, safePage + 1) }))
                            }
                          >
                            {t("Next")}
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 rounded-lg px-1 py-1 text-left text-[11.5px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                        onClick={() => {
                          setExpanded((m) => ({ ...m, [ws]: false }));
                          setPageByWs((m) => ({ ...m, [ws]: 0 }));
                        }}
                      >
                        <ChevronIcon open className="h-3 w-3" />
                        {t("Show less")}
                      </button>
                    </div>
                  )}

                  {archivedSessions.length > 0 && (
                    <div className="mt-0.5">
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[11px] text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                        onClick={() => setShowArchived((m) => ({ ...m, [ws]: !archivedOpen }))}
                      >
                        <ChevronIcon open={archivedOpen} className="h-3 w-3" />
                        {t("Archived")}
                        <span>({archivedSessions.length})</span>
                      </button>
                      {archivedOpen && (
                        <div className="space-y-0.5 pl-1">
                          {archivedSessions.map((s) => (
                            <SessionRow
                              key={s.id}
                              s={s}
                              ws={ws}
                              active={s.id === activeSessionId}
                              sessionIcon={sessionIcon}
                              menuOpen={menuFor === s.id}
                              onToggleMenu={() => setMenuFor((cur) => (cur === s.id ? null : s.id))}
                              onResume={() => {
                                setMenuFor(null);
                                onResumeSession(s.id, ws);
                              }}
                              onUnarchive={
                                onArchiveSession ? () => { setMenuFor(null); onArchiveSession(s.id, false); } : undefined
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}