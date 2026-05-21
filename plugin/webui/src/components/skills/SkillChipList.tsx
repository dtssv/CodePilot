import type { ActiveSkillItem } from '../../state/activeSkillsStore';
import { formatSkillId, skillChipTitle, skillSourceLabel } from './skillDisplay';

export function SkillChipList({ skills }: { skills: ActiveSkillItem[] }) {
    if (skills.length === 0) return null;
    return (
        <div className="active-skills-chips">
            {skills.map((skill) => (
                <span
                    key={`${skill.id}@${skill.version ?? ''}`}
                    className={`active-skill-chip source-${skill.source ?? 'unknown'}`}
                    title={skillChipTitle(skill)}
                >
                    <span className="active-skill-name">{formatSkillId(skill.id)}</span>
                    {skill.source && (
                        <span className="active-skill-source">{skillSourceLabel(skill.source)}</span>
                    )}
                </span>
            ))}
        </div>
    );
}
