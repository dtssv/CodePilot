import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { getRulesMemoryState, installRulesMemoryBridge, rulesApi, subscribeRulesMemory } from '../../state/rulesMemory';

export function ActiveRulesPill() {
    const { t } = useTranslation();
    const [rules, setRules] = useState(() => getRulesMemoryState().rules.filter((r) => r.alwaysApply || r.globs.length > 0));
    useEffect(() => {
        installRulesMemoryBridge();
        rulesApi.reload().catch(() => undefined);
        return subscribeRulesMemory((s) => {
            setRules(s.rules.filter((r) => r.alwaysApply || r.globs.length > 0));
        });
    }, []);
    if (rules.length === 0) return null;
    return (
        <div className="active-rules-pill" title={rules.map((r) => `${r.id}: ${r.description}`).join('\n')}>
            <span className="active-rules-label">{t('panels.rules.pillLabel')}</span>
            <span className="active-rules-count">{rules.length}</span>
        </div>
    );
}
