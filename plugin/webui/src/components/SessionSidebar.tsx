export interface SessionInfo {
    id: string;
    title: string;
    mode: string;
    createdAt: string;
    lastMessageAt: string | null;
}

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

export function SessionSidebar({ sessions, activeSessionId, onSelect, onDelete }: SessionSidebarProps) {
    return (
        <div className="session-popup-list">
            {sessions.length === 0 && (
                <div className="session-empty">No chat history</div>
            )}
            {sessions.map((s) => (
                <div
                    key={s.id}
                    className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
                    onClick={() => onSelect(s.id)}
                >
                    <div className="session-item-title">{s.title}</div>
                    <div className="session-item-meta">
                        <span className="session-time">{formatTime(s.lastMessageAt || s.createdAt)}</span>
                        <button
                            className="session-delete-btn"
                            onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                            title="Delete"
                        >
                            ×
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}