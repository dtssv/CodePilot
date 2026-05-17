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
}

const EMPTY: UsageState = { byDay: {}, byModel: {} };

export function UsagePanel() {
    const [usage, setUsage] = useState<UsageState>(EMPTY);
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
        <div className="usage-panel">
            <h3>Usage</h3>
            <div className="usage-grid">
                <UsageCard title="Today cost" value={`$${(todayBucket?.costUsd ?? 0).toFixed(4)}`} />
                <UsageCard title="Today tokens" value={formatTokens((todayBucket?.inputTokens ?? 0) + (todayBucket?.outputTokens ?? 0))} />
                <UsageCard title="Requests" value={String(todayBucket?.count ?? 0)} />
            </div>
            <h4>By Model</h4>
            {modelRows.length === 0 ? <div className="muted">No usage yet.</div> : (
                <div className="usage-table">
                    {modelRows.map(([model, bucket]) => (
                        <div key={model} className="usage-row">
                            <span>{model}</span>
                            <span>{bucket.count} req</span>
                            <span>{formatTokens(bucket.inputTokens)} in</span>
                            <span>{formatTokens(bucket.outputTokens)} out</span>
                            <span>${bucket.costUsd.toFixed(4)}</span>
                        </div>
                    ))}
                </div>
            )}
            <h4>Last 30 Days</h4>
            <Sparkline data={dayRows.map(([day, bucket]) => ({ day, cost: bucket.costUsd }))} />
        </div>
    );
}

function UsageCard({ title, value }: { title: string; value: string }) {
    return <div className="usage-card"><div className="usage-card-title">{title}</div><div className="usage-card-value">{value}</div></div>;
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
