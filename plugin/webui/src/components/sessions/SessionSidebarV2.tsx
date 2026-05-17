import { Fragment, useMemo, useState } from 'react';
import { sendToPlugin } from '../../bridge';
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

export function SessionSidebarV2({ sessions, activeSessionId, onSelect, onNew, onDelete }: Props) {
    const [query, setQuery] = useState('');
    const [showArchived, setShowArchived] = useState(false);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sessions.filter((s) => {
            if (s.archived && !showArchived) return false;
            if (!q) return true;
            return (s.title ?? '').toLowerCase().includes(q) ||
                (s.preview ?? '').toLowerCase().includes(q) ||
                (s.mode ?? '').toLowerCase().includes(q);
        });
    }, [sessions, query, showArchived]);

    const pinned = filtered.filter((s) => s.pinned);
    const groups = groupByDate(filtered.filter((s) => !s.pinned));

    return (
        <div className="session-sidebar-v2">
            <div className="session-sidebar-actions">
                <button type="button" onClick={onNew}>+ New</button>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话..." />
                <label>
                    <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                    archived
                </label>
            </div>
            {pinned.length > 0 && (
                <>
                    <div className="session-group-label">Pinned</div>
                    {pinned.map((s) => <SessionRow key={s.id} session={s} active={s.id === activeSessionId} onSelect={onSelect} onDelete={onDelete} />)}
                </>
            )}
            {Object.entries(groups).map(([label, list]) => (
                <Fragment key={label}>
                    <div className="session-group-label">{label}</div>
                    {list.map((s) => <SessionRow key={s.id} session={s} active={s.id === activeSessionId} onSelect={onSelect} onDelete={onDelete} />)}
                </Fragment>
            ))}
            {filtered.length === 0 && <div className="session-empty">{query ? 'No matching sessions' : 'No chat history'}</div>}
        </div>
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
    const [renaming, setRenaming] = useState(false);
    const [title, setTitle] = useState(session.title);
    return (
        <div className={`session-row-v2 ${active ? 'active' : ''} ${session.archived ? 'archived' : ''}`} onClick={() => onSelect(session.id)}>
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
                    <div className="session-row-title" title={session.preview}>{session.title || 'Untitled'}</div>
                )}
                <div className="session-row-preview">{session.preview || `${session.mode} · ${session.messageCount ?? 0} msgs`}</div>
            </div>
            <div className="session-row-actions" onClick={(e) => e.stopPropagation()}>
                <button type="button" onClick={() => sendToPlugin('session.pin', { id: session.id, pinned: !session.pinned })}>
                    {session.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button type="button" onClick={() => sendToPlugin('session.archive', { id: session.id, archived: !session.archived })}>
                    {session.archived ? 'Unarchive' : 'Archive'}
                </button>
                <button type="button" onClick={() => setRenaming(true)}>Rename</button>
                <button type="button" onClick={() => sendToPlugin('session.duplicate', { id: session.id })}>Duplicate</button>
                <button type="button" onClick={() => onDelete(session.id)}>×</button>
            </div>
        </div>
    );
}

function groupByDate(list: SessionInfoV2[]): Record<string, SessionInfoV2[]> {
    const now = Date.now();
    const day = 86_400_000;
    const groups: Record<string, SessionInfoV2[]> = { Today: [], Yesterday: [], 'This Week': [], Older: [] };
    for (const s of list) {
        const t = new Date(s.lastMessageAt || s.updatedAt || s.createdAt).getTime();
        const diff = now - t;
        if (diff < day) groups.Today.push(s);
        else if (diff < day * 2) groups.Yesterday.push(s);
        else if (diff < day * 7) groups['This Week'].push(s);
        else groups.Older.push(s);
    }
    for (const key of Object.keys(groups)) groups[key].sort((a, b) =>
        new Date(b.lastMessageAt || b.updatedAt || b.createdAt).getTime() -
        new Date(a.lastMessageAt || a.updatedAt || a.createdAt).getTime());
    return Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0));
}
