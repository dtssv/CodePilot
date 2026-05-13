import { useCallback, useEffect, useRef, useState } from 'react';

export interface ConsoleEntry {
    id: string;
    timestamp: Date;
    type: 'sse' | 'tool' | 'error' | 'info' | 'bridge';
    source: string; // e.g., 'delta', 'tool_call', 'done', 'sendToPlugin'
    data: unknown;
    collapsed?: boolean;
}

interface ConsolePanelProps {
    entries: ConsoleEntry[];
    onClear: () => void;
}

const TYPE_COLORS: Record<string, string> = {
    sse: '#4ec9b0',
    tool: '#d7ba7d',
    error: '#f14c4c',
    info: '#9d9d9d',
    bridge: '#569cd6',
};

const TYPE_LABELS: Record<string, string> = {
    sse: 'SSE',
    tool: 'TOOL',
    error: 'ERR',
    info: 'INFO',
    bridge: 'BRIDGE',
};

function formatTimestamp(d: Date): string {
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
        `.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function truncate(str: string, maxLen: number = 300): string {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + `... (${str.length} chars total)`;
}

function DataPreview({ data, collapsed }: { data: unknown; collapsed: boolean }) {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (collapsed) {
        return <span className="console-data-preview">{truncate(typeof data === 'string' ? data : JSON.stringify(data))}</span>;
    }
    return <pre className="console-data-full">{jsonStr}</pre>;
}

export function ConsolePanel({ entries, onClear }: ConsolePanelProps) {
    const [filter, setFilter] = useState<string>('all');
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [autoScroll, setAutoScroll] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);

    const filteredEntries = filter === 'all' ? entries : entries.filter(e => e.type === filter);

    useEffect(() => {
        if (autoScroll && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [filteredEntries.length, autoScroll]);

    const toggleCollapse = useCallback((id: string) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    return (
        <div className="console-panel">
            <div className="console-header">
                <span className="console-title">Console</span>
                <div className="console-filters">
                    {['all', 'sse', 'tool', 'bridge', 'error'].map(f => (
                        <button
                            key={f}
                            className={`console-filter-btn ${filter === f ? 'active' : ''}`}
                            onClick={() => setFilter(f)}
                        >
                            {f === 'all' ? 'All' : TYPE_LABELS[f] || f}
                        </button>
                    ))}
                </div>
                <div className="console-actions">
                    <label className="console-autoscroll-label">
                        <input
                            type="checkbox"
                            checked={autoScroll}
                            onChange={(e) => setAutoScroll(e.target.checked)}
                        />
                        Auto-scroll
                    </label>
                    <button className="console-clear-btn" onClick={onClear}>Clear</button>
                </div>
            </div>
            <div className="console-entries" ref={scrollRef}>
                {filteredEntries.length === 0 && (
                    <div className="console-empty">No events logged yet</div>
                )}
                {filteredEntries.map(entry => (
                    <div
                        key={entry.id}
                        className={`console-entry console-entry-${entry.type}`}
                        onClick={() => toggleCollapse(entry.id)}
                    >
                        <div className="console-entry-header">
                            <span className="console-entry-time">{formatTimestamp(entry.timestamp)}</span>
                            <span className="console-entry-type" style={{ color: TYPE_COLORS[entry.type] }}>
                                [{TYPE_LABELS[entry.type]}]
                            </span>
                            <span className="console-entry-source">{entry.source}</span>
                        </div>
                        <DataPreview data={entry.data} collapsed={collapsed.has(entry.id)} />
                    </div>
                ))}
            </div>
        </div>
    );
}