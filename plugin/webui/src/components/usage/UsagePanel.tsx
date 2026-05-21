import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';
import { useTranslation } from '../../i18n';

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
    const { t } = useTranslation();
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

    const subtitle =
        t('panels.usage.subtitleTokens') +
        (usage.persisted ? (usage.backend === 'db' ? t('panels.usage.subtitleDb') : t('panels.synced')) : '');

    return (
        <div className="panel-base usage-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{t('panels.usage.title')}</h3>
                    <span className="panel-subtitle">{subtitle}</span>
                </div>
                <button type="button" className="panel-btn" onClick={() => sendToPlugin('usage.get', {}).catch(() => undefined)}>
                    {t('common.refresh')}
                </button>
            </header>
            {usage.quotaWarnings && usage.quotaWarnings.length > 0 && (
                <div className="panel-banner panel-banner-warn">
                    {t('panels.usage.quotaWarn', {
                        limit: usage.quotaWarnings[0].dailyLimitUsd?.toFixed(2) ?? '—',
                    })}
                </div>
            )}
            <div className="panel-section panel-quota-form">
                <h4 className="panel-section-title">{t('panels.usage.dailyQuota')}</h4>
                <div className="panel-row">
                    <input
                        className="panel-input"
                        type="number"
                        min={0}
                        step={0.5}
                        placeholder={
                            usage.quotaWarnings?.[0]?.dailyLimitUsd != null
                                ? String(usage.quotaWarnings[0].dailyLimitUsd)
                                : t('panels.usage.quotaPlaceholder')
                        }
                        value={quotaInput}
                        onChange={(e) => {
                            setQuotaInput(e.target.value);
                            setQuotaSaved(false);
                        }}
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
                        {quotaSaved ? t('panels.usage.saved') : t('panels.usage.setQuota')}
                    </button>
                </div>
                <p className="panel-hint muted">{t('panels.usage.quotaHint')}</p>
            </div>
            <div className="panel-stats-grid">
                <UsageCard title={t('panels.usage.todayCost')} value={`${(todayBucket?.costUsd ?? 0).toFixed(4)}`} />
                <UsageCard title={t('panels.usage.todayTokens')} value={formatTokens((todayBucket?.inputTokens ?? 0) + (todayBucket?.outputTokens ?? 0))} />
                <UsageCard title={t('panels.usage.requests')} value={String(todayBucket?.count ?? 0)} />
            </div>
            <div className="panel-section">
                <h4 className="panel-section-title">{t('panels.usage.byModel')}</h4>
                {modelRows.length === 0 ? (
                    <div className="panel-empty">{t('panels.usage.emptyUsage')}</div>
                ) : (
                    <div className="panel-table">
                        {modelRows.map(([model, bucket]) => (
                            <div key={model} className="panel-table-row">
                                <span className="panel-table-cell-name">{model}</span>
                                <span>{t('panels.req', { n: bucket.count })}</span>
                                <span>{t('panels.tokensIn', { n: formatTokens(bucket.inputTokens) })}</span>
                                <span>{t('panels.tokensOut', { n: formatTokens(bucket.outputTokens) })}</span>
                                <span className="panel-table-cell-cost">${bucket.costUsd.toFixed(4)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="panel-section">
                <h4 className="panel-section-title">{t('panels.usage.last30Days')}</h4>
                <Sparkline data={dayRows.map(([day, bucket]) => ({ day, cost: bucket.costUsd }))} />
            </div>
        </div>
    );
}

function UsageCard({ title, value }: { title: string; value: string }) {
    return (
        <div className="panel-stat-card">
            <div className="panel-stat-label">{title}</div>
            <div className="panel-stat-value">{value}</div>
        </div>
    );
}

function Sparkline({ data }: { data: { day: string; cost: number }[] }) {
    const { t } = useTranslation();
    if (data.length === 0) return <div className="muted">{t('panels.usage.noDailyData')}</div>;
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
