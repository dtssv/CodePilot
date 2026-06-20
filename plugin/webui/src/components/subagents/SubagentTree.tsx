/**
 * Renders the subagents spawned during a turn (Task_subagent).
 *
 * Each subagent is shown as a card with its agent role, description, live
 * progress, and final result/error. Driven entirely by the v2 envelope
 * subagent_spawn / subagent_progress / subagent_complete / subagent_failed events.
 */

import { useTranslation } from '../../i18n';
import type { SubagentNode } from '../../state/events';

const STATUS_ICON: Record<SubagentNode['status'], string> = {
    running: '◐',
    success: '✓',
    error: '✕',
};

export function SubagentTree({ subagents }: { subagents?: SubagentNode[] }) {
    const { t } = useTranslation();
    if (!subagents || subagents.length === 0) return null;

    return (
        <div className="subagent-tree" role="group" aria-label={t('subagent.groupLabel')}>
            <div className="subagent-tree-header">
                <span className="subagent-tree-icon" aria-hidden>
                    ⛓
                </span>
                <span className="subagent-tree-title">{t('subagent.title')}</span>
                <span className="subagent-tree-count">{subagents.length}</span>
            </div>
            <div className="subagent-tree-body">
                {subagents.map((s) => (
                    <SubagentCard key={s.taskId} node={s} />
                ))}
            </div>
        </div>
    );
}

function SubagentCard({ node }: { node: SubagentNode }) {
    const { t } = useTranslation();
    const duration =
        node.endedAt != null ? Math.round((node.endedAt - node.startedAt) / 100) / 10 : undefined;

    return (
        <div className={`subagent-card subagent-${node.status}`}>
            <div className="subagent-card-head">
                <span className={`subagent-status subagent-status-${node.status}`} aria-hidden>
                    {STATUS_ICON[node.status]}
                </span>
                <span className="subagent-agent-name">{node.agentName}</span>
                {duration != null && <span className="subagent-duration muted">{duration}s</span>}
            </div>
            {node.description && <div className="subagent-desc">{node.description}</div>}
            {node.status === 'running' && node.progress && (
                <div className="subagent-progress muted">{node.progress}</div>
            )}
            {node.status === 'success' && node.result && (
                <details className="subagent-result">
                    <summary>{t('subagent.result')}</summary>
                    <pre className="subagent-result-body">{node.result}</pre>
                </details>
            )}
            {node.status === 'error' && node.error && (
                <div className="subagent-error" role="alert">
                    {node.error}
                </div>
            )}
        </div>
    );
}
