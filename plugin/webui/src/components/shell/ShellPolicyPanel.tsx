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
        <section className="shell-policy-panel">
            <header>
                <h3>Shell Policy</h3>
                <button type="button" onClick={() => shellPolicyApi.save(policy)}>Save</button>
            </header>
            <label>
                Default action
                <select
                    value={policy.defaultAction}
                    onChange={(e) => setPolicy({ ...policy, defaultAction: e.target.value as ShellPolicyState['defaultAction'] })}
                >
                    <option value="ask">ask</option>
                    <option value="allow">allow</option>
                    <option value="deny">deny</option>
                </select>
            </label>
            <div className="shell-rule-list">
                {policy.rules.map((rule, idx) => (
                    <div key={`${rule.pattern}:${idx}`} className="shell-rule-row">
                        <input
                            value={rule.pattern}
                            onChange={(e) => updateRule(idx, { pattern: e.target.value }, policy, setPolicy)}
                            placeholder="^git status"
                        />
                        <select
                            value={rule.action}
                            onChange={(e) => updateRule(idx, { action: e.target.value as ShellRule['action'] }, policy, setPolicy)}
                        >
                            <option value="allow">allow</option>
                            <option value="ask">ask</option>
                            <option value="deny">deny</option>
                        </select>
                        <button
                            type="button"
                            onClick={() => setPolicy({ ...policy, rules: policy.rules.filter((_, i) => i !== idx) })}
                        >
                            Remove
                        </button>
                    </div>
                ))}
            </div>
            <button
                type="button"
                onClick={() => setPolicy({ ...policy, rules: [...policy.rules, { pattern: '^git status( |$)', action: 'allow' }] })}
            >
                Add rule
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
