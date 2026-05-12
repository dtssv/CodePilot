import { useMemo, useState } from 'react';

export interface SessionInfo {
    id: string;
    title: string;
    mode: string;
    createdAt: string;
    lastMessageAt: string | null;
}

type GroupBy = 'date' | 'mode';

interface SessionSidebarProps {
    sessions: SessionInfo[];
    activeSessionId: string;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
}

function formatTime(iso: string | null): string {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
        return '';
    }
}

function getDateGroup(iso: string): string {
    try {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return 'This Week';
        if (diffDays < 30) return 'This Month';
        return 'Older';
    } catch {
        return 'Other';
    }
}

export function SessionSidebar({ sessions, activeSessionId, onSelect, onDelete }: SessionSidebarProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [groupBy, setGroupBy] = useState<GroupBy>('date');

    const filteredSessions = useMemo(() => {
        if (!searchQuery) return sessions;
        const q = searchQuery.toLowerCase();
        return sessions.filter(s =>
            s.title?.toLowerCase().includes(q) ||
            s.mode?.toLowerCase().includes(q)
        );
    }, [sessions, searchQuery]);

    const grouped = useMemo(() => {
        if (groupBy === 'mode') {
            const groups = new Map<string, SessionInfo[]>();
            for (const s of filteredSessions) {
                const key = s.mode || 'chat';
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(s);
            }
            return groups;
        }
        // Group by date
        const groups = new Map<string, SessionInfo[]>();
        const dateOrder = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older', 'Other'];
        for (const s of filteredSessions) {
            const key = getDateGroup(s.lastMessageAt || s.createdAt);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(s);
        }
        // Sort groups by date order
        const sorted = new Map<string, SessionInfo[]>();
        for (const key of dateOrder) {
            if (groups.has(key)) sorted.set(key, groups.get(key)!);
        }
        return sorted;
    }, [filteredSessions, groupBy]);

    return (
        <div className="session-sidebar">
            {/* Search bar */}
            <div className="session-search">
                <input
                    type="text"
                    className="session-search-input"
                    placeholder="Search sessions..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
            </div>

            {/* Group toggle */}
            <div className="session-group-toggle">
                <button
                    className={`group-btn ${groupBy === 'date' ? 'active' : ''}`}
                    onClick={() => setGroupBy('date')}
                >Date</button>
                <button
                    className={`group-btn ${groupBy === 'mode' ? 'active' : ''}`}
                    onClick={() => setGroupBy('mode')}
                >Mode</button>
            </div>

            {/* Session list with groups */}
            <div className="session-popup-list">
                {filteredSessions.length === 0 && (
                    <div className="session-empty">{searchQuery ? 'No matching sessions' : 'No chat history'}</div>
                )}
                {Array.from(grouped.entries()).map(([group, items]) => (
                    <div key={group} className="session-group">
                        <div className="session-group-label">{group}</div>
                        {items.map((s) => (
                            <div
                                key={s.id}
                                className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
                                onClick={() => onSelect(s.id)}
                            >
                                <div className="session-item-title">{s.title || 'Untitled'}</div>
                                <div className="session-item-meta">
                                    <span className="session-time">{formatTime(s.lastMessageAt || s.createdAt)}</span>
                                    <span className={`session-mode-tag ${s.mode}`}>{s.mode}</span>
                                    <button
                                        className="session-delete-btn"
                                        onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                                        title="Delete"
                                    >×</button>
                                </div>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}