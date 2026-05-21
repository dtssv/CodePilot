import type { SkillActivationRecord } from '../../state/events';
import { useTranslation } from '../../i18n';
import { SkillChipList } from './SkillChipList';
import { skillNodeLabel } from './skillDisplay';

export function TurnSkillHistory({ activations }: { activations: SkillActivationRecord[] }) {
    const { t } = useTranslation();
    if (!activations.length) return null;

    return (
        <div className="turn-skill-history" aria-label={t('skills.historyTitle')}>
            <div className="turn-skill-history-title">{t('skills.historyTitle')}</div>
            {activations.map((entry, index) => (
                <div
                    key={`${entry.node}-${entry.ts}-${index}`}
                    className="turn-skill-history-entry"
                >
                    <div className="turn-skill-history-entry-header">
                        <span className="active-skills-node">{skillNodeLabel(entry.node)}</span>
                        <span className="turn-skill-history-count">
                            {t('skills.count', { n: entry.skills.length })}
                        </span>
                    </div>
                    <SkillChipList skills={entry.skills} />
                </div>
            ))}
        </div>
    );
}
