import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
    getShellPolicy,
    installShellPolicyBridge,
    shellPolicyApi,
    subscribeShellPolicy,
    type ShellPolicyState,
    type ShellRule,
} from '../../state/shellPolicy';

export function ShellPolicyPanel() {
    const { t } = useTranslation();
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
                    <h3 className="panel-title">{t('panels.shell.title')}</h3>
                    <span className="panel-subtitle">{t('panels.shell.subtitle')}</span>
                </div>
                <button type="button" className="panel-btn panel-btn-primary" onClick={() => shellPolicyApi.save(policy)}>
                    {t('panels.save')}
                </button>
            </header>
            <label className="panel-field">
                <span className="panel-label">{t('panels.shell.defaultAction')}</span>
                <select
                    className="panel-select"
                    value={policy.defaultAction}
                    onChange={(e) => setPolicy({ ...policy, defaultAction: e.target.value as ShellPolicyState['defaultAction'] })}
                >
                    <option value="ask">{t('panels.shell.action.ask')}</option>
                    <option value="allow">{t('panels.shell.action.allow')}</option>
                    <option value="deny">{t('panels.shell.action.deny')}</option>
                </select>
            </label>
            <div className="panel-section">
                {policy.rules.map((rule, idx) => (
                    <div key={`${rule.pattern}:${idx}`} className="panel-row">
                        <input
                            className="panel-input"
                            value={rule.pattern}
                            onChange={(e) => updateRule(idx, { pattern: e.target.value }, policy, setPolicy)}
                            placeholder={t('panels.shell.patternPlaceholder')}
                        />
                        <select
                            className="panel-select panel-select-sm"
                            value={rule.action}
                            onChange={(e) => updateRule(idx, { action: e.target.value as ShellRule['action'] }, policy, setPolicy)}
                        >
                            <option value="allow">{t('panels.shell.action.allow')}</option>
                            <option value="ask">{t('panels.shell.action.ask')}</option>
                            <option value="deny">{t('panels.shell.action.deny')}</option>
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
                {t('panels.shell.addRule')}
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
    setPolicy({ ...policy, rules: policy.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)) });
}
