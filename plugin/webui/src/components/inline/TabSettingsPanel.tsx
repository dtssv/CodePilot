import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';
import { useTranslation } from '../../i18n';

/**
 * P0-04 — Tab completion settings + acceptance metrics.
 */

export interface TabStats {
    suggestCount: number;
    acceptCount: number;
    dismissCount: number;
    avgLatencyMs: number;
    acceptRate: number;
    lastPredictSource?: string;
    byPredictSource?: Record<string, number>;
}

const ZERO: TabStats = {
    suggestCount: 0,
    acceptCount: 0,
    dismissCount: 0,
    avgLatencyMs: 0,
    acceptRate: 0,
};

export function TabSettingsPanel() {
    const { t } = useTranslation();
    const [stats, setStats] = useState<TabStats>(ZERO);
    const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);

    useEffect(() => {
        const offSnap = onPluginEvent('tab.stats_response', (raw) => {
            const s = raw as Partial<TabStats>;
            setStats({
                suggestCount: s.suggestCount ?? 0,
                acceptCount: s.acceptCount ?? 0,
                dismissCount: s.dismissCount ?? 0,
                avgLatencyMs: s.avgLatencyMs ?? 0,
                acceptRate: s.acceptRate ?? 0,
                lastPredictSource: s.lastPredictSource,
                byPredictSource: s.byPredictSource,
            });
        });
        const offEnv = onPluginEvent('envelope', (envRaw) => {
            const env = envRaw as { type?: string; payload?: Record<string, unknown> };
            if (env?.type === 'tab.suggest') {
                setStats((p) => ({ ...p, suggestCount: p.suggestCount + 1 }));
                const lat = env.payload?.latencyMs;
                if (typeof lat === 'number') setLastLatencyMs(lat);
            } else if (env?.type === 'tab.accept') {
                setStats((p) => {
                    const accept = p.acceptCount + 1;
                    return {
                        ...p,
                        acceptCount: accept,
                        acceptRate: p.suggestCount > 0 ? accept / p.suggestCount : 0,
                    };
                });
            } else if (env?.type === 'tab.dismiss') {
                setStats((p) => ({ ...p, dismissCount: p.dismissCount + 1 }));
            }
        });
        sendToPlugin('tab.get_stats', {}).catch(() => undefined);
        return () => {
            offSnap();
            offEnv();
        };
    }, []);

    const pct = (stats.acceptRate * 100).toFixed(1);

    return (
        <div className="panel-base tab-settings">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{t('panels.tab.title')}</h3>
                    <span className="panel-subtitle">{t('panels.tab.subtitle')}</span>
                </div>
                <div className="panel-actions">
                    <button type="button" className="panel-btn" onClick={() => sendToPlugin('tab.get_stats', {})}>
                        {t('common.refresh')}
                    </button>
                    <button type="button" className="panel-btn panel-btn-danger" onClick={() => sendToPlugin('tab.reset_stats', {})}>
                        {t('panels.reset')}
                    </button>
                </div>
            </header>
            <div className="panel-stats-grid">
                <div className="panel-stat-card">
                    <div className="panel-stat-label">{t('panels.tab.suggestions')}</div>
                    <div className="panel-stat-value">{stats.suggestCount}</div>
                </div>
                <div className="panel-stat-card">
                    <div className="panel-stat-label">{t('panels.tab.accepted')}</div>
                    <div className="panel-stat-value">{stats.acceptCount}</div>
                </div>
                <div className="panel-stat-card">
                    <div className="panel-stat-label">{t('panels.tab.dismissed')}</div>
                    <div className="panel-stat-value">{stats.dismissCount}</div>
                </div>
                <div className="panel-stat-card">
                    <div className="panel-stat-label">{t('panels.tab.acceptRate')}</div>
                    <div className="panel-stat-value">{stats.suggestCount === 0 ? '—' : `${pct}%`}</div>
                </div>
                <div className="panel-stat-card">
                    <div className="panel-stat-label">{t('panels.tab.avgLatency')}</div>
                    <div className="panel-stat-value">{stats.avgLatencyMs}ms</div>
                </div>
                {lastLatencyMs !== null && (
                    <div className="panel-stat-card">
                        <div className="panel-stat-label">{t('panels.tab.lastLatency')}</div>
                        <div className="panel-stat-value">{lastLatencyMs}ms</div>
                    </div>
                )}
            </div>
            {(stats.lastPredictSource || stats.byPredictSource) && (
                <div className="panel-section">
                    <h4 className="panel-section-title">{t('panels.tab.predictionSource')}</h4>
                    <p className="panel-hint muted">{t('panels.tab.routeHint', { route: stats.lastPredictSource ?? '—' })}</p>
                    {stats.byPredictSource && Object.keys(stats.byPredictSource).length > 0 && (
                        <div className="panel-table">
                            {Object.entries(stats.byPredictSource).map(([src, n]) => (
                                <div key={src} className="panel-table-row">
                                    <span className="panel-table-cell-name">{src}</span>
                                    <span>{t('panels.hits', { n })}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
