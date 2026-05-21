import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { MarketplacePanel } from '../MarketplacePanel';
import { McpHooksPanel } from '../mcp/McpHooksPanel';
import { CreateSkillPanel } from './CreateSkillPanel';

const SECTION_KEY = 'codepilot.integrations.section';

export type IntegrationsSection = 'skills' | 'createSkill' | 'mcp';

export function IntegrationsPanel() {
    const { t } = useTranslation();
    const [section, setSection] = useState<IntegrationsSection>(() => {
        try {
            const raw = localStorage.getItem(SECTION_KEY);
            if (raw === 'mcp' || raw === 'skills' || raw === 'createSkill') return raw;
        } catch {
            /* ignore */
        }
        return 'skills';
    });

    useEffect(() => {
        try {
            localStorage.setItem(SECTION_KEY, section);
        } catch {
            /* ignore */
        }
    }, [section]);

    return (
        <div className="integrations-panel">
            <div className="integrations-intro muted">{t('integrations.intro')}</div>
            <div className="integrations-subnav" role="tablist" aria-label={t('integrations.subnavAria')}>
                <button
                    type="button"
                    role="tab"
                    aria-selected={section === 'skills'}
                    className={section === 'skills' ? 'integrations-subtab integrations-subtab-active' : 'integrations-subtab'}
                    onClick={() => setSection('skills')}
                >
                    {t('nav.integrationsSkills')}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={section === 'createSkill'}
                    className={section === 'createSkill' ? 'integrations-subtab integrations-subtab-active' : 'integrations-subtab'}
                    onClick={() => setSection('createSkill')}
                >
                    {t('nav.integrationsCreateSkill')}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={section === 'mcp'}
                    className={section === 'mcp' ? 'integrations-subtab integrations-subtab-active' : 'integrations-subtab'}
                    onClick={() => setSection('mcp')}
                >
                    {t('nav.integrationsMcp')}
                </button>
            </div>
            <div className="integrations-body" role="tabpanel">
                {section === 'skills' ? (
                    <MarketplacePanel />
                ) : section === 'createSkill' ? (
                    <CreateSkillPanel />
                ) : (
                    <McpHooksPanel />
                )}
            </div>
        </div>
    );
}
