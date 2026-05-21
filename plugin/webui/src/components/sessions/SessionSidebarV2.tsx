import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { sendToPlugin } from '../../bridge';
import { useTranslation } from '../../i18n';
import type { BranchNode } from '../branches/BranchTreeView';

export interface SessionInfoV2 {
    id: string;
    title: string;
    mode: string;
    createdAt: string;
    updatedAt?: string;
    lastMessageAt: string | null;
    messageCount?: number;
    pinned?: boolean;
    archived?: boolean;
    preview?: string;
    branches?: BranchNode[];
}

interface Props {
    sessions: SessionInfoV2[];
    activeSessionId: string;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
}

type SectionId = 'pinned' | 'today' | 'yesterday' | 'thisWeek' | 'older';

const DATE_ORDER: Array<'today' | 'yesterday' | 'thisWeek' | 'older'> = ['today', 'yesterday', 'thisWeek', 'older'];

const GROUP_KEY: Record<SectionId, string> = {
    pinned: 'sessions.groupPinned',
    today: 'sessions.groupToday',
    yesterday: 'sessions.groupYesterday',
    thisWeek: 'sessions.groupThisWeek',
    older: 'sessions.groupOlder',
};

const DEFAULT_EXPANDED: Record<SectionId, boolean> = {
    pinned: true,
    today: true,
    yesterday: false,
    thisWeek: false,
    older: false,
};

export function SessionSidebarV2({ sessions, activeSessionId, onSelect, onNew, onDelete }: Props) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [showArchived, setShowArchived] = useState(false);
    const [expanded, setExpanded] = useState<Record<SectionId, boolean>>({ ...DEFAULT_EXPANDED });

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sessions.filter((s) => {
            if (s.archived && !showArchived) return false;
            if (!q) return true;
            return (
                (s.title ?? '').toLowerCase().includes(q) ||
                (s.preview ?? '').toLowerCase().includes(q) ||
                (s.mode ?? '').toLowerCase().includes(q)
            );
        });
    }, [sessions, query, showArchived]);

    const pinned = filtered.filter((s) => s.pinned);
    const dateGroups = useMemo(() => groupByDate(filtered.filter((s) => !s.pinned)), [filtered]);

    const visibleSectionIds = useMemo(() => {
        const ids: SectionId[] = [];
        if (pinned.length > 0) ids.push('pinned');
        for (const g of dateGroups) ids.push(g.id);
        return ids;
    }, [pinned.length, dateGroups]);

    const toggleSection = useCallback((id: SectionId) => {
        setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    const expandAll = useCallback(() => {
        setExpanded((prev) => {
            const next = { ...prev };
            for (const id of visibleSectionIds) next[id] = true;
            return next;
        });
    }, [visibleSectionIds]);

    const collapseAll = useCallback(() => {
        setExpanded((prev) => {
            const next = { ...prev };
            for (const id of visibleSectionIds) next[id] = false;
            return next;
        });
    }, [visibleSectionIds]);

    const isOpen = (id: SectionId) => expanded[id] !== false;

    return (
        <div className="session-sidebar-v2">
            <div className="session-sidebar-actions">
                <button type="button" className="session-sidebar-btn-primary" onClick={onNew}>
                    + {t('sessions.newDialog')}
                </button>
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('sessions.searchPlaceholder')}
                    className="session-sidebar-search"
                />
                <label className="session-sidebar-archived">
                    <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                    {t('sessions.showArchived')}
                </label>
            </div>
            {visibleSectionIds.length > 0 && (
                <div className="session-sidebar-bulk">
                    <button type="button" className="session-sidebar-link-btn" onClick={expandAll}>
                        {t('sessions.expandAll')}
                    </button>
                    <span className="session-sidebar-bulk-sep" aria-hidden>
                        ·
                    </span>
                    <button type="button" className="session-sidebar-link-btn" onClick={collapseAll}>
                        {t('sessions.collapseAll')}
                    </button>
                </div>
            )}
            {pinned.length > 0 && (
                <SessionModule
                    title={t(GROUP_KEY.pinned)}
                    count={pinned.length}
                    open={isOpen('pinned')}
                    onToggle={() => toggleSection('pinned')}
                >
                    {pinned.map((s) => (
                        <SessionRow key={s.id} session={s} active={s.id === activeSessionId} onSelect={onSelect} onDelete={onDelete} />
                    ))}
                </SessionModule>
            )}
            {dateGroups.map(({ id, items }) => (
                <SessionModule
                    key={id}
                    title={t(GROUP_KEY[id])}
                    count={items.length}
                    open={isOpen(id)}
                    onToggle={() => toggleSection(id)}
                >
                    {items.map((s) => (
                        <SessionRow key={s.id} session={s} active={s.id === activeSessionId} onSelect={onSelect} onDelete={onDelete} />
                    ))}
                </SessionModule>
            ))}
            {filtered.length === 0 && (
                <div className="session-empty">{query ? t('sessions.emptySearch') : t('sessions.empty')}</div>
            )}
        </div>
    );
}

function SessionModule({
    title,
    count,
    open,
    onToggle,
    children,
}: {
    title: string;
    count: number;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    return (
        <section className="session-sidebar-module">
            <button type="button" className="session-sidebar-module-header" onClick={onToggle} aria-expanded={open}>
                <span className="session-sidebar-module-chevron" aria-hidden>
                    {open ? '▼' : '▶'}
                </span>
                <span className="session-sidebar-module-title">{title}</span>
                <span className="session-sidebar-module-count">{count}</span>
            </button>
            {open && <div className="session-sidebar-module-body">{children}</div>}
        </section>
    );
}

function SessionRow({
    session,
    active,
    onSelect,
    onDelete,
}: {
    session: SessionInfoV2;
    active: boolean;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [renaming, setRenaming] = useState(false);
    const [title, setTitle] = useState(session.title);

    const previewFallback = `${session.mode} · ${t('sessions.rowMsgs', { n: session.messageCount ?? 0 })}`;

    return (
        <div
            className={`session-row-v2 ${active ? 'active' : ''} ${session.archived ? 'archived' : ''}`}
            onClick={() => onSelect(session.id)}
        >
            <div className="session-row-main">
                {renaming ? (
                    <input
                        value={title}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setTitle(e.target.value)}
                        onBlur={() => {
                            setRenaming(false);
                            sendToPlugin('session.rename', { id: session.id, title });
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                setRenaming(false);
                                sendToPlugin('session.rename', { id: session.id, title });
                            }
                        }}
                    />
                ) : (
                    <div className="session-row-title" title={session.preview}>
                        {session.title || t('sessions.rowUntitled')}
                    </div>
                )}
                <div className="session-row-preview">{session.preview || previewFallback}</div>
            </div>
            <div className="session-row-actions" onClick={(e) => e.stopPropagation()}>
                <button
                    type="button"
                    className="session-row-action-icon"
                    title={session.pinned ? t('sessions.unpin') : t('sessions.pin')}
                    aria-label={session.pinned ? t('sessions.unpin') : t('sessions.pin')}
                    onClick={() => sendToPlugin('session.pin', { id: session.id, pinned: !session.pinned })}
                >
                    📌
                </button>
                <button
                    type="button"
                    className="session-row-action-icon"
                    title={session.archived ? t('sessions.unarchive') : t('sessions.archive')}
                    aria-label={session.archived ? t('sessions.unarchive') : t('sessions.archive')}
                    onClick={() => sendToPlugin('session.archive', { id: session.id, archived: !session.archived })}
                >
                    📦
                </button>
                <button
                    type="button"
                    className="session-row-action-icon"
                    title={t('sessions.rename')}
                    aria-label={t('sessions.rename')}
                    onClick={() => setRenaming(true)}
                >
                    ✎
                </button>
                <button
                    type="button"
                    className="session-row-action-icon"
                    title={t('sessions.duplicate')}
                    aria-label={t('sessions.duplicate')}
                    onClick={() => sendToPlugin('session.duplicate', { id: session.id })}
                >
                    ⧉
                </button>
                <button
                    type="button"
                    className="session-row-action-icon session-row-action-danger"
                    title={t('sessions.delete')}
                    aria-label={t('sessions.delete')}
                    onClick={() => onDelete(session.id)}
                >
                    ×
                </button>
            </div>
        </div>
    );
}

function groupByDate(list: SessionInfoV2[]): { id: 'today' | 'yesterday' | 'thisWeek' | 'older'; items: SessionInfoV2[] }[] {
    const now = Date.now();
    const day = 86_400_000;
    const buckets: Record<'today' | 'yesterday' | 'thisWeek' | 'older', SessionInfoV2[]> = {
        today: [],
        yesterday: [],
        thisWeek: [],
        older: [],
    };
    for (const s of list) {
        const ts = new Date(s.lastMessageAt || s.updatedAt || s.createdAt).getTime();
        const diff = now - ts;
        if (diff < day) buckets.today.push(s);
        else if (diff < day * 2) buckets.yesterday.push(s);
        else if (diff < day * 7) buckets.thisWeek.push(s);
        else buckets.older.push(s);
    }
    for (const key of DATE_ORDER) {
        buckets[key].sort(
            (a, b) =>
                new Date(b.lastMessageAt || b.updatedAt || b.createdAt).getTime() -
                new Date(a.lastMessageAt || a.updatedAt || a.createdAt).getTime(),
        );
    }
    return DATE_ORDER.filter((id) => buckets[id].length > 0).map((id) => ({ id, items: buckets[id] }));
}
