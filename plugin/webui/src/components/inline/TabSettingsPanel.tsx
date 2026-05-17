import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';

/**
 * P0-04 — Tab completion settings + acceptance metrics.
 *
 * Layout: enable toggle (mirrors plugin settings.codeCompletionEnabled if you
 * wire it through later), live counters that come from
 * `EventTypes.TAB_SUGGEST/ACCEPT/DISMISS` envelopes, and a "refresh" that asks
 * the plugin for an authoritative snapshot.
 */

export interface TabStats {
    suggestCount: number;
    acceptCount: number;
    dismissCount: number;
    avgLatencyMs: number;
    acceptRate: number;
}

const ZERO: TabStats = {
    suggestCount: 0,
    acceptCount: 0,
    dismissCount: 0,
    avgLatencyMs: 0,
    acceptRate: 0,
};

export function TabSettingsPanel() {
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
            });
        });
        // Also accumulate from envelopes so the UI is responsive even between
        // explicit snapshot fetches.
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
        <div className="tab-settings">
            <header className="tab-settings-header">
                <h3>Tab Completion</h3>
                <div className="tab-settings-actions">
                    <button type="button" onClick={() => sendToPlugin('tab.get_stats', {})}>
                        Refresh
                    </button>
                    <button type="button" onClick={() => sendToPlugin('tab.reset_stats', {})}>
                        Reset stats
                    </button>
                </div>
            </header>
            <dl className="tab-stats">
                <div className="tab-stat">
                    <dt>Suggestions</dt><dd>{stats.suggestCount}</dd>
                </div>
                <div className="tab-stat">
                    <dt>Accepted</dt><dd>{stats.acceptCount}</dd>
                </div>
                <div className="tab-stat">
                    <dt>Dismissed</dt><dd>{stats.dismissCount}</dd>
                </div>
                <div className="tab-stat">
                    <dt>Accept rate</dt><dd>{stats.suggestCount === 0 ? '—' : `${pct}%`}</dd>
                </div>
                <div className="tab-stat">
                    <dt>Avg latency</dt><dd>{stats.avgLatencyMs}ms</dd>
                </div>
                {lastLatencyMs !== null && (
                    <div className="tab-stat">
                        <dt>Last latency</dt><dd>{lastLatencyMs}ms</dd>
                    </div>
                )}
            </dl>
        </div>
    );
}
