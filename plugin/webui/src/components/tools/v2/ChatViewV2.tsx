/**
 * Demo / opt-in v2 ChatView.
 *
 * Renders the v2 store's turn/step tree using the new ToolCallCard. Existing
 * components (legacy ChatView, AgentStepCard, MarkdownRenderer, …) are not
 * modified — this component is mounted only when
 * `localStorage['codepilot.protocol.v2'] === '1'`.
 *
 * Wire into App.tsx like:
 *
 *   import { isV2Enabled } from './state/chatStore';
 *   import { ChatViewV2 } from './components/tools/v2/ChatViewV2';
 *   {isV2Enabled() ? <ChatViewV2 /> : <ChatView ... />}
 */

import { useChatV2 } from '../../../state/chatStore';
import type { StepNode, TurnNode } from '../../../state/events';
import { ToolCallCard } from './ToolCallCard';

export function ChatViewV2() {
    const turns = useChatV2((s) => s.turns);
    const steps = useChatV2((s) => s.steps);

    if (turns.length === 0) {
        return <div className="chat-view-v2 empty">No conversation yet.</div>;
    }
    return (
        <div className="chat-view-v2">
            {turns.map((turn) => (
                <TurnView key={turn.turnId} turn={turn} steps={steps} />
            ))}
        </div>
    );
}

function TurnView({ turn, steps }: { turn: TurnNode; steps: Record<string, StepNode> }) {
    return (
        <article className={`turn turn-${turn.status}`}>
            <header className="turn-user">
                <span className="role-badge">You</span>
                <div className="turn-user-content">{turn.userMessage}</div>
                {turn.contextRefs.length > 0 && (
                    <div className="turn-context-refs">
                        {turn.contextRefs.map((c, i) => (
                            <span key={i} className="ref-chip">{c.display}</span>
                        ))}
                    </div>
                )}
            </header>
            <section className="turn-assistant">
                <span className="role-badge assistant">AI</span>
                <div className="turn-steps">
                    {turn.stepIds
                        .map((id) => steps[id])
                        .filter((s): s is StepNode => Boolean(s))
                        .map(renderStep)}
                </div>
                <footer className="turn-footer">
                    <span className={`turn-status status-${turn.status}`}>{turn.status}</span>
                    {turn.endedAt && (
                        <span className="muted">{Math.round((turn.endedAt - turn.startedAt) / 100) / 10}s</span>
                    )}
                </footer>
            </section>
        </article>
    );
}

function renderStep(step: StepNode) {
    switch (step.kind) {
        case 'tool':
            return <ToolCallCard key={step.stepId} step={step} />;
        case 'llm':
            return <LlmStep key={step.stepId} step={step} />;
        case 'thinking':
            return <ThinkingStep key={step.stepId} step={step} />;
        case 'plan':
            return <PlanStep key={step.stepId} step={step} />;
        default:
            return <GenericStep key={step.stepId} step={step} />;
    }
}

function LlmStep({ step }: { step: StepNode }) {
    if (!step.textBuf) return null;
    // The legacy MarkdownRenderer can be reused here; kept as <pre> to avoid
    // pulling that dependency into the v2 tree before the wider migration.
    return (
        <div className="step step-llm">
            <pre className="step-text">{step.textBuf}</pre>
            {step.status === 'running' && <span className="streaming-dot" aria-label="streaming">▍</span>}
        </div>
    );
}

function ThinkingStep({ step }: { step: StepNode }) {
    return (
        <details className="step step-thinking" open={step.status === 'running'}>
            <summary>{step.title || 'Thinking'} <span className={`step-status status-${step.status}`}>{step.status}</span></summary>
            <pre className="step-thinking-body">{step.thinkingBuf || step.title}</pre>
        </details>
    );
}

function PlanStep({ step }: { step: StepNode }) {
    return (
        <div className="step step-plan">
            <div className="step-title">📋 {step.title || 'Plan'}</div>
            {step.plan && (
                <ol className="plan-steps">
                    {step.plan.map((s) => (
                        <li key={s.id} className={`plan-${s.status}`}>
                            <span>{s.title}</span>
                            <span className="muted">{s.status}</span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
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
