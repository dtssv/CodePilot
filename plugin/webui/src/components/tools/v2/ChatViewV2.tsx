/**
 * v2 ChatView — turn/step tree with legacy-quality plan + tool cards.
 */

import { sendToPlugin } from '../../../bridge';
import { useChatV2 } from '../../../state/chatStore';
import type { RiskNotice, StepNode, TurnNode } from '../../../state/events';
import { planStatusCssClass, planStatusIcon } from '../../../state/planNormalize';
import { useBranches } from '../../../state/sessionUiStore';
import { AgentContentRenderer } from '../../AgentContentRenderer';
import { AgentStepCard, type AgentStep } from '../../AgentStepCard';
import { BranchTimeline } from '../../BranchTimeline';
import { ContextRefChips } from '../../ContextRefChips';
import { MessageImages } from '../../MessageImages';
import { NeedsInputCard } from '../../NeedsInputCard';
import { ShellStepCard, type ShellStepState } from '../../shell/ShellStepCard';
import { ToolCallCard as LegacyToolCallCard } from '../../ToolCallCard';
import { shouldHideToolStep, stepToToolCall } from './stepToToolCall';

export function ChatViewV2() {
    const turns = useChatV2((s) => s.turns);
    const steps = useChatV2((s) => s.steps);
    const { branches, activeBranchId } = useBranches();

    if (turns.length === 0) {
        return (
            <div className="chat-view chat-view-v2 empty">
                <div className="chat-empty">
                    <div className="chat-empty-icon">◇</div>
                    <div className="chat-empty-title">CodePilot</div>
                    <p className="chat-empty-hint">Start a conversation to see agent steps, tools, and plans here.</p>
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
    const notices = turn.riskNotices ?? [];
    const needs = turn.needsInput;
    if (notices.length === 0 && !needs) return null;
    return (
        <div className="turn-alerts">
            {notices.map((n, i) => (
                <RiskBanner key={`risk-${i}`} notice={n} />
            ))}
            {needs && (
                <div className="turn-needs-input">
                    <NeedsInputCard payload={needs as Parameters<typeof NeedsInputCard>[0]['payload']} />
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
    const stepList = turn.stepIds
        .map((id) => steps[id])
        .filter((s): s is StepNode => Boolean(s));

    const planStepIds = stepList.filter((s) => s.kind === 'plan').map((s) => s.stepId);
    const latestPlanId = planStepIds.length > 0 ? planStepIds[planStepIds.length - 1] : null;

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
                            title="Fork conversation from this message"
                            onClick={() =>
                                sendToPlugin('fork_from_message', { messageIndex: turn.forkMessageIndex }).catch(
                                    () => undefined,
                                )
                            }
                        >
                            ↗ Fork
                        </button>
                    )}
                </div>
            </div>
            <div className="msg-row msg-row-assistant">
                <div className="msg-avatar msg-avatar-assistant" aria-hidden>
                    ✦
                </div>
                <div className="msg msg-assistant">
                    <TurnAlerts turn={turn} />
                    <div className="turn-steps">
                        {stepList.map((step) => {
                            if (step.kind === 'plan' && step.stepId !== latestPlanId) return null;
                            if (step.kind === 'tool' && shouldHideToolStep(step, stepList)) return null;
                            return renderStep(step, stepList);
                        })}
                    </div>
                    <footer className="turn-footer">
                        <span className={`turn-status status-${turn.status}`}>{turn.status}</span>
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

/** Internal step kinds that should be hidden from the main chat flow.
 *  These are driver events (verify, repair, subtask phase markers) that
 *  pollute the conversation with low-level state information. */
const HIDDEN_STEP_KINDS = new Set([
    'verify', 'repair', 'subtask', 'phase', 'diagnose', 'validate',
]);

/** Tool names that are internal/diagnostic and should not appear as cards. */
const HIDDEN_TOOL_PREFIXES = [
    'ide.shadowValidate', 'ide.diagnostics', 'plan.show', 'plan.update',
];

function shouldHideStep(step: StepNode, allSteps: StepNode[]): boolean {
    // Hide internal driver event kinds
    if (HIDDEN_STEP_KINDS.has(step.kind)) return true;

    // Hide subtask completion markers (title like "阶段完成: phase" or "success")
    if (step.kind === 'subtask' || step.title?.startsWith('阶段完成') || step.title === 'success') {
        return true;
    }

    // Hide internal diagnostic tools
    const tool = step.toolCall?.tool ?? '';
    if (HIDDEN_TOOL_PREFIXES.some((p) => tool.startsWith(p))) return true;

    // Hide tool steps that are already represented by agent writing/running steps
    if (step.kind === 'tool' && shouldHideToolStep(step, allSteps)) return true;

    return false;
}

function renderStep(step: StepNode, allSteps: StepNode[]) {
    // Filter out internal/driver steps that should not appear in the chat flow
    if (shouldHideStep(step, allSteps)) return null;

    switch (step.kind) {
        case 'tool': {
            const tc = stepToToolCall(step);
            if (!tc) return null;
            return (
                <div key={step.stepId} className="msg-tool-calls">
                    <LegacyToolCallCard toolCall={tc} />
                </div>
            );
        }
        case 'llm':
            return <LlmStep key={step.stepId} step={step} />;
        case 'thinking':
            return <ThinkingStep key={step.stepId} step={step} />;
        case 'plan':
            return <PlanStep key={step.stepId} step={step} />;
        case 'reading':
        case 'writing':
        case 'running':
            return (
                <div key={step.stepId} className="agent-steps-container">
                    <AgentStepCard step={agentStepFromNode(step)} />
                </div>
            );
        case 'verify':
        case 'repair':
            // Render as compact agent step (not hidden, but compact)
            return (
                <div key={step.stepId} className="agent-steps-container agent-steps-compact">
                    <AgentStepCard step={agentStepFromNode(step)} compact />
                </div>
            );
        default:
            if (isShellStep(step)) {
                return <ShellStepCard key={step.stepId} step={shellStepFromNode(step)} />;
            }
            // Unknown step kinds: only show if they have meaningful content
            if (!step.title && !step.textBuf) return null;
            return <GenericStep key={step.stepId} step={step} />;
    }
}

function LlmStep({ step }: { step: StepNode }) {
    if (!step.textBuf) return null;
    return (
        <div className="step step-llm">
            <AgentContentRenderer content={step.textBuf} isStreaming={step.status === 'running'} />
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

function PlanStep({ step }: { step: StepNode }) {
    if (!step.plan?.length) return null;
    return (
        <div className="plan-steps-container">
            <div className="plan-steps-header">📋 执行计划</div>
            {step.plan.map((s, idx) => (
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
    return {
        type: typeMap[step.kind] ?? 'checking',
        content: step.title,
        status: step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'success',
        detail: step.progressDetail as AgentStep['detail'],
    };
}

function isShellStep(step: StepNode): boolean {
    const tool = step.toolCall?.tool ?? '';
    return tool.startsWith('shell.') || (step.progressDetail as { kind?: string } | undefined)?.kind === 'shell';
}

function shellStepFromNode(step: StepNode): ShellStepState {
    const p = (step.progressDetail ?? step.toolResult?.result ?? {}) as Record<string, unknown>;
    return {
        id: step.stepId,
        command: String(p.command ?? step.title ?? 'shell'),
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
