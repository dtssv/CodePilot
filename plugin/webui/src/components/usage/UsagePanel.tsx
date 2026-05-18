import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';

interface AggBucket {
    count: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

interface UsageState {
    byDay: Record<string, AggBucket>;
    byModel: Record<string, AggBucket>;
    quotaWarnings?: { userId?: string; warning?: string; dailyLimitUsd?: number }[];
    recordCount?: number;
    persisted?: boolean;
    backend?: 'db' | 'file';
    dailyQuotaUsd?: number;
}

const EMPTY: UsageState = { byDay: {}, byModel: {} };

export function UsagePanel() {
    const [usage, setUsage] = useState<UsageState>(EMPTY);
    const [quotaInput, setQuotaInput] = useState('');
    const [quotaSaved, setQuotaSaved] = useState(false);
    useEffect(() => {
        const off = onPluginEvent('usage.update', (payload) => setUsage(payload as UsageState));
        sendToPlugin('usage.get', {}).catch(() => undefined);
        return off;
    }, []);
    const today = new Date().toISOString().slice(0, 10);
    const todayBucket = usage.byDay[today];
    const modelRows = Object.entries(usage.byModel);
    const dayRows = Object.entries(usage.byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-30);
    return (
        <div className="panel-base usage-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">📊 Usage</h3>
                    <span className="panel-subtitle">
                        Token & cost tracking
                        {usage.persisted ? (usage.backend === 'db' ? ' · DB' : ' · synced') : ''}
                    </span>
                </div>
                <button type="button" className="panel-btn" onClick={() => sendToPlugin('usage.get', {}).catch(() => undefined)}>
                    Refresh
                </button>
            </header>
            {usage.quotaWarnings && usage.quotaWarnings.length > 0 && (
                <div className="panel-banner panel-banner-warn">
                    Approaching daily quota (${usage.quotaWarnings[0].dailyLimitUsd?.toFixed(2) ?? '—'} limit)
                </div>
            )}
            <div className="panel-section panel-quota-form">
                <h4 className="panel-section-title">Daily quota (USD)</h4>
                <div className="panel-row">
                    <input
                        className="panel-input"
                        type="number"
                        min={0}
                        step={0.5}
                        placeholder={usage.quotaWarnings?.[0]?.dailyLimitUsd != null ? String(usage.quotaWarnings[0].dailyLimitUsd) : 'e.g. 10'}
                        value={quotaInput}
                        onChange={(e) => { setQuotaInput(e.target.value); setQuotaSaved(false); }}
                    />
                    <button
                        type="button"
                        className="panel-btn panel-btn-primary"
                        onClick={() => {
                            const limit = parseFloat(quotaInput);
                            if (Number.isNaN(limit) || limit < 0) return;
                            sendToPlugin('usage.set_quota', { userId: 'default', dailyLimitUsd: limit }).catch(() => undefined);
                            setQuotaSaved(true);
                        }}
                    >
                        {quotaSaved ? 'Saved' : 'Set quota'}
                    </button>
                </div>
                <p className="panel-hint muted">Warns when today&apos;s spend reaches 90% of this limit (requires backend).</p>
            </div>
            <div className="panel-stats-grid">
                <UsageCard title="Today cost" value={`${(todayBucket?.costUsd ?? 0).toFixed(4)}`} />
                <UsageCard title="Today tokens" value={formatTokens((todayBucket?.inputTokens ?? 0) + (todayBucket?.outputTokens ?? 0))} />
                <UsageCard title="Requests" value={String(todayBucket?.count ?? 0)} />
            </div>
            <div className="panel-section">
                <h4 className="panel-section-title">By Model</h4>
                {modelRows.length === 0 ? <div className="panel-empty">No usage yet.</div> : (
                    <div className="panel-table">
                        {modelRows.map(([model, bucket]) => (
                            <div key={model} className="panel-table-row">
                                <span className="panel-table-cell-name">{model}</span>
                                <span>{bucket.count} req</span>
                                <span>{formatTokens(bucket.inputTokens)} in</span>
                                <span>{formatTokens(bucket.outputTokens)} out</span>
                                <span className="panel-table-cell-cost">${bucket.costUsd.toFixed(4)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="panel-section">
                <h4 className="panel-section-title">Last 30 Days</h4>
                <Sparkline data={dayRows.map(([day, bucket]) => ({ day, cost: bucket.costUsd }))} />
            </div>
        </div>
    );
}

function UsageCard({ title, value }: { title: string; value: string }) {
    return <div className="panel-stat-card"><div className="panel-stat-label">{title}</div><div className="panel-stat-value">{value}</div></div>;
}

function Sparkline({ data }: { data: { day: string; cost: number }[] }) {
    if (data.length === 0) return <div className="muted">No daily data yet.</div>;
    const max = Math.max(...data.map((d) => d.cost), 0.0001);
    const width = 480;
    const height = 80;
    const step = width / Math.max(1, data.length - 1);
    const points = data.map((d, i) => `${i * step},${height - (d.cost / max) * height}`).join(' ');
    return (
        <svg width={width} height={height} className="usage-sparkline">
            <polyline points={points} fill="none" stroke="#58a6ff" strokeWidth={2} />
            {data.map((d, i) => (
                <circle key={d.day} cx={i * step} cy={height - (d.cost / max) * height} r={2}>
                    <title>{d.day}: ${d.cost.toFixed(4)}</title>
                </circle>
            ))}
        </svg>
    );
}

function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}
