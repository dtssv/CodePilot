import { useEffect, useState } from 'react';
import {
    getRulesMemoryState,
    installRulesMemoryBridge,
    memoryApi,
    rulesApi,
    subscribeRulesMemory,
    type MemoryItem,
    type RuleItem,
} from '../../state/rulesMemory';

export function RulesMemoryPanel() {
    const [rules, setRules] = useState<RuleItem[]>(getRulesMemoryState().rules);
    const [memories, setMemories] = useState<MemoryItem[]>(getRulesMemoryState().memories);
    const [newRuleBody, setNewRuleBody] = useState('- Follow existing project style.');

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
                    <h3 className="panel-title">📜 Rules & Memories</h3>
                    <span className="panel-subtitle">Project rules · long-term memory</span>
                </div>
                <button type="button" className="panel-btn" onClick={() => rulesApi.reload()}>Reload</button>
            </header>

            <div className="panel-section">
                <h4 className="panel-section-title">Active Rule Files</h4>
                {rules.length === 0 ? <p className="panel-empty">No `.mdc`, `AGENTS.md`, or legacy rules found.</p> : (
                    <ul className="panel-list">
                        {rules.map((r) => (
                            <li key={r.id} className={`panel-card source-${r.source}`}>
                                <div className="rule-meta">
                                    <code>{r.id}</code>
                                    <span>{r.source}</span>
                                    <span>{r.alwaysApply ? 'always' : r.globs.join(', ') || 'manual'}</span>
                                </div>
                                <strong>{r.description}</strong>
                                <pre>{r.body.slice(0, 800)}</pre>
                            </li>
                        ))}
                    </ul>
                )}

                <details className="panel-details">
                    <summary>Create project rule</summary>
                    <textarea className="panel-textarea" rows={6} value={newRuleBody} onChange={(e) => setNewRuleBody(e.target.value)} />
                    <button
                        type="button"
                        className="panel-btn panel-btn-primary"
                        onClick={() => rulesApi.create({
                            id: `rule-${Date.now()}.mdc`,
                            description: 'Project rule',
                            globs: ['**/*'],
                            body: newRuleBody,
                        })}
                    >
                        Save `.codepilot/rules/*.mdc`
                    </button>
                </details>
            </div>

            <div className="panel-section">
                <h4 className="panel-section-title">
                    Pending review
                    {pending.length > 0 && <span className="panel-badge panel-badge-warn">{pending.length}</span>}
                </h4>
                {pending.length === 0 ? (
                    <p className="panel-empty">No memories awaiting review.</p>
                ) : (
                    <ul className="panel-list">
                        {pending.map((m) => (
                            <li key={m.id} className="panel-card memory-pending">
                                <div className="panel-card-meta">
                                    <code>{m.kind}</code>
                                    <span>{m.scope}</span>
                                    <span className="panel-badge status-suggested">suggested</span>
                                    <span>{Math.round((m.confidence ?? 0) * 100)}%</span>
                                </div>
                                <p>{m.text}</p>
                                <div className="panel-actions">
                                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => memoryApi.setStatus(m.id, 'approved')}>Approve</button>
                                    <button type="button" className="panel-btn" onClick={() => memoryApi.setStatus(m.id, 'rejected')}>Reject</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="panel-section">
                <h4 className="panel-section-title">All memories</h4>
                {reviewed.length === 0 && pending.length === 0 ? <p className="panel-empty">No memories yet.</p> : (
                    <ul className="panel-list">
                        {reviewed.map((m) => (
                            <li key={m.id} className="panel-card">
                                <div className="panel-card-meta">
                                    <code>{m.kind}</code>
                                    <span>{m.scope}</span>
                                    <span className={`panel-badge status-${m.status}`}>{m.status}</span>
                                    <span>{Math.round((m.confidence ?? 0) * 100)}%</span>
                                </div>
                                <p>{m.text}</p>
                                <div className="panel-actions">
                                    <button type="button" className="panel-btn" onClick={() => memoryApi.setStatus(m.id, 'approved')}>Approve</button>
                                    <button type="button" className="panel-btn" onClick={() => memoryApi.setStatus(m.id, 'rejected')}>Reject</button>
                                    <button type="button" className="panel-btn panel-btn-danger" onClick={() => memoryApi.remove(m.id)}>Delete</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}
