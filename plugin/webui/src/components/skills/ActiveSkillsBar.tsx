/**
 * Shows Skills activated for the current graph node (planning / generate / repair).
 */

import { useTranslation } from '../../i18n';
import { useActiveSkills } from '../../state/activeSkillsStore';
import { SkillChipList } from './SkillChipList';
import { skillNodeLabel } from './skillDisplay';

export function ActiveSkillsBar() {
    const { t } = useTranslation();
    const active = useActiveSkills();
    if (!active || active.skills.length === 0) return null;

    return (
        <div
            className="active-skills-bar"
            role="status"
            aria-live="polite"
            aria-label={`${skillNodeLabel(active.node)} — ${t('skills.activated')}`}
        >
            <div className="active-skills-header">
                <span className="active-skills-icon" aria-hidden>
                    ✦
                </span>
                <span className="active-skills-node">{skillNodeLabel(active.node)}</span>
                <span className="active-skills-label">{t('skills.activated')}</span>
                <span className="active-skills-count">{active.skills.length}</span>
            </div>
            <SkillChipList skills={active.skills} />
        </div>
    );
}
