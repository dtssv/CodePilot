import { useEffect, useState } from 'react';
import {
    getShellPolicy,
    installShellPolicyBridge,
    shellPolicyApi,
    subscribeShellPolicy,
    type ShellPolicyState,
    type ShellRule,
} from '../../state/shellPolicy';

export function ShellPolicyPanel() {
    const [policy, setPolicy] = useState<ShellPolicyState>(getShellPolicy());

    useEffect(() => {
        installShellPolicyBridge();
        const off = subscribeShellPolicy(setPolicy);
        shellPolicyApi.get().catch(() => undefined);
        return off;
    }, []);

    return (
        <section className="panel-base shell-policy-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">⌨️ Shell Policy</h3>
                    <span className="panel-subtitle">Command allow/deny rules</span>
                </div>
                <button type="button" className="panel-btn panel-btn-primary" onClick={() => shellPolicyApi.save(policy)}>Save</button>
            </header>
            <label className="panel-field">
                <span className="panel-label">Default action</span>
                <select
                    className="panel-select"
                    value={policy.defaultAction}
                    onChange={(e) => setPolicy({ ...policy, defaultAction: e.target.value as ShellPolicyState['defaultAction'] })}
                >
                    <option value="ask">ask</option>
                    <option value="allow">allow</option>
                    <option value="deny">deny</option>
                </select>
            </label>
            <div className="panel-section">
                {policy.rules.map((rule, idx) => (
                    <div key={`${rule.pattern}:${idx}`} className="panel-row">
                        <input
                            className="panel-input"
                            value={rule.pattern}
                            onChange={(e) => updateRule(idx, { pattern: e.target.value }, policy, setPolicy)}
                            placeholder="^git status"
                        />
                        <select
                            className="panel-select panel-select-sm"
                            value={rule.action}
                            onChange={(e) => updateRule(idx, { action: e.target.value as ShellRule['action'] }, policy, setPolicy)}
                        >
                            <option value="allow">allow</option>
                            <option value="ask">ask</option>
                            <option value="deny">deny</option>
                        </select>
                        <button
                            type="button"
                            className="panel-btn panel-btn-danger"
                            onClick={() => setPolicy({ ...policy, rules: policy.rules.filter((_, i) => i !== idx) })}
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>
            <button
                type="button"
                className="panel-btn"
                onClick={() => setPolicy({ ...policy, rules: [...policy.rules, { pattern: '^git status( |$)', action: 'allow' }] })}
            >
                + Add rule
            </button>
        </section>
    );
}

function updateRule(
    idx: number,
    patch: Partial<ShellRule>,
    policy: ShellPolicyState,
    setPolicy: (p: ShellPolicyState) => void,
) {
    setPolicy({ ...policy, rules: policy.rules.map((r, i) => i === idx ? { ...r, ...patch } : r) });
}
