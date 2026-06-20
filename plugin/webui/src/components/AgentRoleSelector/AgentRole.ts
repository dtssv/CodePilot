export type AgentRole = 'build' | 'plan' | 'compose';

export const AGENT_ROLES: { id: AgentRole; labelKey: string; descKey: string }[] = [
    { id: 'build', labelKey: 'Build', descKey: 'Full permissions for code writing & execution' },
    { id: 'plan', labelKey: 'Plan', descKey: 'Read-only analysis & design' },
    { id: 'compose', labelKey: 'Compose', descKey: 'Skill-driven workflow orchestration' },
];