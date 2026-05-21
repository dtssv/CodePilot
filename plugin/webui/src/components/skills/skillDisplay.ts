import { t } from '../../i18n';

export function formatSkillId(id: string): string {
    return id.replace(/^skill\./, '');
}

export function skillNodeLabel(node: string): string {
    const key = `skills.node.${node}` as const;
    const label = t(key);
    return label === key ? node : label;
}

export function skillSourceLabel(source?: string): string {
    if (!source) return '';
    if (source === 'system') return t('skills.source.system');
    if (source === 'user') return t('skills.source.user');
    return source;
}

export function skillChipTitle(skill: {
    id: string;
    version?: string;
    scope?: string;
    tokens?: number;
}): string {
    return [
        skill.id,
        skill.version ? `v${skill.version}` : '',
        skill.scope ? `scope: ${skill.scope}` : '',
        skill.tokens != null ? `~${skill.tokens} tok` : '',
    ]
        .filter(Boolean)
        .join(' · ');
}
