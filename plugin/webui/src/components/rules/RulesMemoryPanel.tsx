import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
    getRulesMemoryState,
    installRulesMemoryBridge,
    memoryApi,
    rulesApi,
    subscribeRulesMemory,
    type MemoryItem,
    type RuleItem,
} from '../../state/rulesMemory';

function memStatusLabel(t: (k: string) => string, status: MemoryItem['status']): string {
    const key = `panels.rules.memoryStatus.${status}`;
    const v = t(key);
    return v === key ? status : v;
}

export function RulesMemoryPanel() {
    const { t } = useTranslation();
    const [rules, setRules] = useState<RuleItem[]>(getRulesMemoryState().rules);
    const [memories, setMemories] = useState<MemoryItem[]>(getRulesMemoryState().memories);
    const [newRuleBody, setNewRuleBody] = useState(() => t('panels.rules.defaultNewRule'));

    useEffect(() => {
        installRulesMemoryBridge();
        const off = subscribeRulesMemory((s) => {
            setRules(s.rules);
            setMemories(s.memories);
        });
        rulesApi.list().catch(() => undefined);
        memoryApi.list().catch(() => undefined);
        return off;
    }, []);

    const pending = memories.filter((m) => m.status === 'suggested');
    const reviewed = memories.filter((m) => m.status !== 'suggested');

    return (
        <section className="panel-base rules-memory-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{t('panels.rules.title')}</h3>
                    <span className="panel-subtitle">{t('panels.rules.subtitle')}</span>
                </div>
                <button type="button" className="panel-btn" onClick={() => rulesApi.reload()}>
                    {t('panels.reload')}
                </button>
            </header>

            <div className="panel-section">
                <h4 className="panel-section-title">{t('panels.rules.sectionActiveFiles')}</h4>
                {rules.length === 0 ? (
                    <p className="panel-empty">{t('panels.rules.emptyRules')}</p>
                ) : (
                    <ul className="panel-list">
                        {rules.map((r) => (
                            <li key={r.id} className={`panel-card source-${r.source}`}>
                                <div className="rule-meta">
                                    <code>{r.id}</code>
                                    <span>{r.source}</span>
                                    <span>
                                        {r.alwaysApply ? t('panels.always') : r.globs.join(', ') || t('panels.manual')}
                                    </span>
                                </div>
                                <strong>{r.description}</strong>
                                <pre>{r.body.slice(0, 800)}</pre>
                            </li>
                        ))}
                    </ul>
                )}

                <details className="panel-details">
                    <summary>{t('panels.rules.createRule')}</summary>
                    <textarea className="panel-textarea" rows={6} value={newRuleBody} onChange={(e) => setNewRuleBody(e.target.value)} />
                    <button
                        type="button"
                        className="panel-btn panel-btn-primary"
                        onClick={() =>
                            rulesApi.create({
                                id: `rule-${Date.now()}.mdc`,
                                description: t('panels.rules.defaultRuleDesc'),
                                globs: ['**/*'],
                                body: newRuleBody,
                            })}
                    >
                        {t('panels.rules.saveRulePath')}
                    </button>
                </details>
            </div>

            <div className="panel-section">
                <h4 className="panel-section-title">
                    {t('panels.rules.pendingTitle')}
                    {pending.length > 0 && <span className="panel-badge panel-badge-warn">{pending.length}</span>}
                </h4>
                {pending.length === 0 ? (
                    <p className="panel-empty">{t('panels.rules.emptyPending')}</p>
                ) : (
                    <ul className="panel-list">
                        {pending.map((m) => (
                            <li key={m.id} className="panel-card memory-pending">
                                <div className="panel-card-meta">
                                    <code>{m.kind}</code>
                                    <span>{m.scope}</span>
                                    <span className="panel-badge status-suggested">{memStatusLabel(t, m.status)}</span>
                                    <span>{Math.round((m.confidence ?? 0) * 100)}%</span>
                                </div>
                                <p>{m.text}</p>
                                <div className="panel-actions">
                                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => memoryApi.setStatus(m.id, 'approved')}>
                                        {t('panels.rules.approve')}
                                    </button>
                                    <button type="button" className="panel-btn" onClick={() => memoryApi.setStatus(m.id, 'rejected')}>
                                        {t('panels.rules.reject')}
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="panel-section">
                <h4 className="panel-section-title">{t('panels.rules.allMemories')}</h4>
                {reviewed.length === 0 && pending.length === 0 ? (
                    <p className="panel-empty">{t('panels.rules.emptyMemories')}</p>
                ) : (
                    <ul className="panel-list">
                        {reviewed.map((m) => (
                            <li key={m.id} className="panel-card">
                                <div className="panel-card-meta">
                                    <code>{m.kind}</code>
                                    <span>{m.scope}</span>
                                    <span className={`panel-badge status-${m.status}`}>{memStatusLabel(t, m.status)}</span>
                                    <span>{Math.round((m.confidence ?? 0) * 100)}%</span>
                                </div>
                                <p>{m.text}</p>
                                <div className="panel-actions">
                                    <button type="button" className="panel-btn" onClick={() => memoryApi.setStatus(m.id, 'approved')}>
                                        {t('panels.rules.approve')}
                                    </button>
                                    <button type="button" className="panel-btn" onClick={() => memoryApi.setStatus(m.id, 'rejected')}>
                                        {t('panels.rules.reject')}
                                    </button>
                                    <button type="button" className="panel-btn panel-btn-danger" onClick={() => memoryApi.remove(m.id)}>
                                        {t('common.delete')}
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}
