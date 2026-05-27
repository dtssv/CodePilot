/**
 * v2 ChatView — turn/step tree with legacy-quality plan + tool cards.
 */

import { sendToPlugin } from '../../../bridge';
import { useTranslation } from '../../../i18n';
import { useAdmissionWaitState } from '../../../state/admissionWaitStore';
import { useChatV2 } from '../../../state/chatStore';
import type { RiskNotice, StepNode, TurnNode } from '../../../state/events';
import { useNeedsInputSubmitted } from '../../../state/needsInputStore';
import { planStatusCssClass, planStatusIcon } from '../../../state/planNormalize';
import { useMemoryCompaction } from '../../../state/rulesMemory';
import { useBranches } from '../../../state/sessionUiStore';
import { normalizeAgentContentText, stripGraphMarkers } from '../../../utils/graphMarkers';
import { sortStepsChronologically } from '../../../utils/timelineSort';
import { AgentContentRenderer } from '../../AgentContentRenderer';
import { AgentStepCard, type AgentStep } from '../../AgentStepCard';
import { BranchTimeline } from '../../BranchTimeline';
import { ContextRefChips } from '../../ContextRefChips';
import { MessageImages } from '../../MessageImages';
import { NeedsInputCard } from '../../NeedsInputCard';
import { ShellStepCard, type ShellStepState } from '../../shell/ShellStepCard';
import { TurnSkillHistory } from '../../skills/TurnSkillHistory';
import { ToolCallCard } from '../../ToolCallCard';
import { shouldHideToolStep, stepToToolCall } from './stepToToolCall';

export function ChatViewV2() {
    const { t } = useTranslation();
    const turns = useChatV2((s) => s.turns);
    const steps = useChatV2((s) => s.steps);
    const { branches, activeBranchId } = useBranches();

    if (turns.length === 0) {
        return (
            <div className="chat-view chat-view-v2 empty">
                <div className="chat-empty">
                    <div className="chat-empty-icon">◇</div>
                    <div className="chat-empty-title">{t('chat.emptyTitle')}</div>
                    <p className="chat-empty-hint">{t('chat.emptyHint')}</p>
                </div>
            </div>
        );
    }

    const timelineBranches = branches.map((b) => ({
        branchId: b.branchId,
        parentBranchId: b.parentBranchId ?? undefined,
        parentMsgIndex: b.forkMsgIndex ?? undefined,
        title: b.title || (b.forkMsgIndex != null ? `Fork @ #${b.forkMsgIndex}` : b.branchId),
        messageCount: b.messageCount ?? 0,
        lastMessageAt: b.createdAt != null ? String(b.createdAt) : undefined,
    }));

    return (
        <div className="chat-view chat-view-v2">
            {timelineBranches.length > 1 && (
                <BranchTimeline
                    branches={timelineBranches}
                    activeBranchId={activeBranchId}
                    onSwitchBranch={(branchId) => {
                        const branch = branches.find((b) => b.branchId === branchId);
                        if (branch) sendToPlugin('switch_branch', { sessionId: branch.sessionId }).catch(() => undefined);
                    }}
                />
            )}
            {turns.map((turn) => (
                <TurnView key={turn.turnId} turn={turn} steps={steps} />
            ))}
        </div>
    );
}

function TurnAlerts({ turn }: { turn: TurnNode }) {
    const { t } = useTranslation();
    const notices = turn.riskNotices ?? [];
    const needs = turn.needsInput;
    const compaction = useMemoryCompaction();
    const isSubmitted = useNeedsInputSubmitted(needs?.continuationToken);
    const showInlineNeedsInput = !!needs;
    if (notices.length === 0 && !showInlineNeedsInput && !compaction) return null;
    return (
        <div className="turn-alerts">
            {compaction && (
                <div className="turn-alert turn-alert-compaction" role="status">
                    <strong>上下文已压缩</strong>
                    <span>{compaction.compressedCount} 条低优先级记忆已合并为摘要
                        {compaction.preservedCount > 0 && `（${compaction.preservedCount} 条关键记忆已保留）`}
                    </span>
                    <span className="muted">阶段: {compaction.phaseId || '未知'}，压缩上下文将在会话恢复时自动使用</span>
                </div>
            )}
            {notices.map((n, i) => (
                <RiskBanner key={`risk-${i}`} notice={n} />
            ))}
            {showInlineNeedsInput && (
                <div className="turn-needs-input">
                    {isSubmitted ? (
                        <div className="needs-input-submitted">{t('chat.needsInputSubmitted')}</div>
                    ) : (
                        <NeedsInputCard payload={needs as Parameters<typeof NeedsInputCard>[0]['payload']} />
                    )}
                </div>
            )}
        </div>
    );
}

function RiskBanner({ notice }: { notice: RiskNotice }) {
    return (
        <div className={`turn-alert turn-alert-risk level-${notice.level}`} role="alert">
            <strong>⚠️ {notice.level}</strong>
            <span>{notice.message}</span>
            {notice.filesPaths && notice.filesPaths.length > 0 && (
                <span className="muted">Files: {notice.filesPaths.join(', ')}</span>
            )}
        </div>
    );
}

function TurnView({ turn, steps }: { turn: TurnNode; steps: Record<string, StepNode> }) {
    const { t } = useTranslation();
    const admissionWait = useAdmissionWaitState();
    const stepList = sortStepsChronologically(turn.stepIds, steps);
    const statusLabel =
        turn.status === 'running' && admissionWait
            ? t('chat.waitingAdmission')
            : turn.status === 'interrupted'
                ? t('chat.waitingForInput')
                : turn.status;

    return (
        <article className={`turn turn-${turn.status}`}>
            <div className="msg-row msg-row-user">
                <div className="msg-avatar msg-avatar-user" aria-hidden>
                    U
                </div>
                <div className="msg msg-user">
                    <div className="turn-user-content">{turn.userMessage}</div>
                    <ContextRefChips refs={turn.contextRefs} />
                    {turn.images && turn.images.length > 0 && <MessageImages images={turn.images} />}
                    {turn.forkMessageIndex != null && (
                        <button
                            type="button"
                            className="msg-fork-btn turn-fork-btn"
                            title={t('chat.forkFromMessage')}
                            onClick={() =>
                                sendToPlugin('fork_from_message', { messageIndex: turn.forkMessageIndex }).catch(
                                    () => undefined,
                                )
                            }
                        >
                            ↗ {t('common.fork')}
                        </button>
                    )}
                </div>
            </div>
            <div className="msg-row msg-row-assistant">
                <div className="msg-avatar msg-avatar-assistant" aria-hidden>
                    ✦
                </div>
                <div className="msg msg-assistant">
                    {turn.skillActivations && turn.skillActivations.length > 0 && (
                        <TurnSkillHistory activations={turn.skillActivations} />
                    )}
                    <div className="turn-steps">
                        {stepList.map((step) => renderStep(step, stepList, true))}
                    </div>
                    <TurnAlerts turn={turn} />
                    <footer className="turn-footer">
                        <span className={`turn-status status-${turn.status}${admissionWait && turn.status === 'running' ? ' status-waiting' : ''}`}>
                            {statusLabel}
                        </span>
                        {turn.endedAt && (
                            <span className="muted">{Math.round((turn.endedAt - turn.startedAt) / 100) / 10}s</span>
                        )}
                        {turn.tokenMeta && (
                            <span className="turn-token-meta muted">
                                {turn.tokenMeta.inputTokens != null && turn.tokenMeta.inputTokens > 0 && (
                                    <>↑{turn.tokenMeta.inputTokens} </>
                                )}
                                {turn.tokenMeta.outputTokens != null && turn.tokenMeta.outputTokens > 0 && (
                                    <>↓{turn.tokenMeta.outputTokens} </>
                                )}
                                {turn.tokenMeta.costUsd != null && turn.tokenMeta.costUsd > 0 && (
                                    <>${turn.tokenMeta.costUsd < 0.01 ? '<0.01' : turn.tokenMeta.costUsd.toFixed(3)} </>
                                )}
                                {turn.tokenMeta.modelId && (
                                    <span className="turn-model-id">{turn.tokenMeta.modelId.split('/').pop()}</span>
                                )}
                            </span>
                        )}
                    </footer>
                </div>
            </div>
        </article>
    );
}

/** Internal step kinds hidden once completed (running steps stay visible). */
const HIDDEN_WHEN_DONE_KINDS = new Set(['subtask', 'phase', 'diagnose', 'validate']);

/** Tool names that are internal/diagnostic and should not appear as cards. */
const HIDDEN_TOOL_PREFIXES = [
    'ide.shadowValidate', 'ide.diagnostics', 'plan.show', 'plan.update',
];

function shouldHideStep(step: StepNode, allSteps: StepNode[]): boolean {
    if (HIDDEN_WHEN_DONE_KINDS.has(step.kind) && step.status !== 'running') return true;

    // Hide subtask completion markers (title like "阶段完成: phase" or "success")
    if (
        (step.kind === 'subtask' || step.kind === 'verify' || step.kind === 'repair')
        && step.status !== 'running'
        && (step.title?.startsWith('阶段完成') || step.title === 'success')
    ) {
        return true;
    }

    // Hide internal diagnostic tools
    const tool = step.toolCall?.tool ?? '';
    if (HIDDEN_TOOL_PREFIXES.some((p) => tool.startsWith(p))) return true;

    // Hide tool steps that are already represented by agent writing/running steps
    if (step.kind === 'tool' && shouldHideToolStep(step, allSteps)) return true;

    return false;
}

/** Only the last writing step (merged file list) is shown per turn. */
function isCanonicalWritingStep(step: StepNode, allSteps: StepNode[]): boolean {
    const writingSteps = allSteps.filter((s) => s.kind === 'writing');
    if (writingSteps.length === 0) return true;
    return writingSteps[writingSteps.length - 1].stepId === step.stepId;
}

function renderStep(step: StepNode, allSteps: StepNode[], suppressFilePreviews: boolean) {
    // Filter out internal/driver steps that should not appear in the chat flow
    if (shouldHideStep(step, allSteps)) return null;

    switch (step.kind) {
        case 'plan': {
            if (!step.plan?.length) return null;
            return (
                <div key={step.stepId} className="plan-steps-inline">
                    <PlanStepsView steps={step.plan} />
                </div>
            );
        }
        case 'tool': {
            const call = stepToToolCall(step);
            if (!call) return null;
            return (
                <div key={step.stepId} className="msg-tool-calls">
                    <ToolCallCard toolCall={call} />
                </div>
            );
        }
        case 'llm':
            return <LlmStep key={step.stepId} step={step} suppressFilePreviews={suppressFilePreviews} />;
        case 'thinking':
            return <ThinkingStep key={step.stepId} step={step} />;
        case 'reading':
        case 'writing':
        case 'running':
        case 'verify':
        case 'repair': {
            if (step.kind === 'writing' && !isCanonicalWritingStep(step, allSteps)) {
                return null;
            }
            return (
                <div key={step.stepId} className="agent-steps-container">
                    <AgentStepCard step={agentStepFromNode(step)} />
                </div>
            );
        }
        default:
            if (isShellStep(step)) {
                return <ShellStepCard key={step.stepId} step={shellStepFromNode(step)} />;
            }
            // Unknown step kinds: only show if they have meaningful content
            if (!step.title && !step.textBuf) return null;
            return <GenericStep key={step.stepId} step={step} />;
    }
}

function LlmStep({ step, suppressFilePreviews }: { step: StepNode; suppressFilePreviews?: boolean }) {
    if (!step.textBuf) return null;
    return (
        <div className="step step-llm">
            <AgentContentRenderer
                content={normalizeAgentContentText(step.textBuf)}
                isStreaming={step.status === 'running'}
                suppressFileBlocks={suppressFilePreviews}
            />
        </div>
    );
}

function ThinkingStep({ step }: { step: StepNode }) {
    return (
        <details className="step step-thinking agent-step" open={step.status === 'running'}>
            <summary>
                {step.title || 'Thinking'}{' '}
                <span className={`step-status status-${step.status}`}>{step.status}</span>
            </summary>
            <pre className="step-thinking-body">{step.thinkingBuf || step.title}</pre>
        </details>
    );
}



/** Render plan steps inline in the chronological timeline. */
function PlanStepsView({ steps }: { steps: import('../../../state/events').PlanStep[] }) {
    const { t } = useTranslation();
    return (
        <div className="plan-steps-container">
            <div className="plan-steps-header">📋 {t('chat.planHeader')}</div>
            {steps.map((s, idx) => (
                <div key={s.id || idx} className="plan-step-item">
                    <span className={`plan-step-status plan-step-${planStatusCssClass(s.status)}`}>
                        {planStatusIcon(s.status)}
                    </span>
                    <span className="plan-step-title">{s.title}</span>
                </div>
            ))}
        </div>
    );
}

function agentStepFromNode(step: StepNode): AgentStep {
    const typeMap: Record<string, AgentStep['type']> = {
        reading: 'reading',
        writing: 'writing',
        running: 'running',
        verify: 'checking',
        repair: 'thinking',
    };
    const rawDetail = step.progressDetail as AgentStep['detail'] | undefined;
    const files = rawDetail?.files;
    return {
        type: typeMap[step.kind] ?? 'checking',
        content: stripGraphMarkers(step.title),
        status: step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'success',
        detail: files && files.length > 0 ? { files } : rawDetail,
    };
}

function isShellStep(step: StepNode): boolean {
    const tool = step.toolCall?.tool ?? '';
    return tool.startsWith('shell.') || (step.progressDetail as { kind?: string } | undefined)?.kind === 'shell';
}

function shellStepFromNode(step: StepNode): ShellStepState {
    const p = (step.progressDetail ?? step.toolResult?.result ?? {}) as Record<string, unknown>;
    const args = step.toolCall?.args as { command?: string } | undefined;
    return {
        id: step.stepId,
        command: String(
            p.command ?? args?.command ?? (step.title?.startsWith('shell.') ? '' : step.title) ?? 'shell',
        ),
        startedAt: typeof p.startedAt === 'number' ? p.startedAt : step.startedAt,
        stdout: String(p.stdout ?? p.partial ?? step.textBuf ?? ''),
        stderr: String(p.stderr ?? ''),
        exitCode: typeof p.exitCode === 'number' ? p.exitCode : undefined,
        durationMs: typeof p.durationMs === 'number' ? p.durationMs : undefined,
        status: step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'success',
    };
}

function GenericStep({ step }: { step: StepNode }) {
    return (
        <div className="step step-generic">
            <div className="step-title">{step.kind}: {step.title}</div>
            {step.textBuf && <pre className="step-text">{step.textBuf}</pre>}
            <span className={`step-status status-${step.status}`}>{step.status}</span>
        </div>
    );
}
