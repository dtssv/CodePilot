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

    return (
        <section className="rules-memory-panel">
            <header className="rules-memory-header">
                <h3>Rules & Memories</h3>
                <button type="button" onClick={() => rulesApi.reload()}>Reload rules</button>
            </header>

            <div className="rules-section">
                <h4>Active Rule Files</h4>
                {rules.length === 0 ? <p className="muted">No `.mdc`, `AGENTS.md`, or legacy rules found.</p> : (
                    <ul className="rule-list">
                        {rules.map((r) => (
                            <li key={r.id} className={`rule-item source-${r.source}`}>
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

                <details className="rule-create">
                    <summary>Create project rule</summary>
                    <textarea rows={6} value={newRuleBody} onChange={(e) => setNewRuleBody(e.target.value)} />
                    <button
                        type="button"
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

            <div className="memory-section">
                <h4>Memories</h4>
                {memories.length === 0 ? <p className="muted">No memories yet.</p> : (
                    <ul className="memory-list">
                        {memories.map((m) => (
                            <li key={m.id} className={`memory-item status-${m.status}`}>
                                <div className="memory-meta">
                                    <code>{m.kind}</code>
                                    <span>{m.scope}</span>
                                    <span>{m.status}</span>
                                    <span>{Math.round((m.confidence ?? 0) * 100)}%</span>
                                </div>
                                <p>{m.text}</p>
                                <div className="memory-actions">
                                    <button type="button" onClick={() => memoryApi.setStatus(m.id, 'approved')}>Approve</button>
                                    <button type="button" onClick={() => memoryApi.setStatus(m.id, 'rejected')}>Reject</button>
                                    <button type="button" onClick={() => memoryApi.remove(m.id)}>Delete</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}
