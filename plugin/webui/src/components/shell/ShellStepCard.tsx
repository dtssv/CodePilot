import { useState } from 'react';
import { sendToPlugin } from '../../bridge';

export interface ShellStepState {
    id: string;
    command: string;
    stdout: string;
    stderr: string;
    exitCode?: number;
    durationMs?: number;
    status: 'running' | 'success' | 'error';
    toolCallId?: string;
}

export function ShellStepCard({ step, onStop }: { step: ShellStepState; onStop?: () => void }) {
    const [expanded, setExpanded] = useState(true);
    const handleStop = () => {
        sendToPlugin('stop', {}).catch(() => undefined);
        onStop?.();
    };
    return (
        <div className={`shell-step-card shell-step-${step.status}`}>
            <div
                className="shell-step-header"
                onClick={() => setExpanded((prev) => !prev)}
                onKeyDown={(e) => e.key === 'Enter' && setExpanded((prev) => !prev)}
                role="button"
                tabIndex={0}
            >
                <span className="shell-step-icon">⌨️</span>
                <code className="shell-step-command">{step.command || 'shell'}</code>
                <span className={`shell-step-status shell-step-status-${step.status}`}>
                    {step.status === 'running' && <span className="agent-step-spinner" />}
                    {step.status === 'success' && step.exitCode !== undefined && `exit ${step.exitCode}`}
                    {step.status === 'error' && 'failed'}
                </span>
                {step.status === 'running' && (
                    <button
                        type="button"
                        className="shell-step-stop panel-btn"
                        onClick={(e) => { e.stopPropagation(); handleStop(); }}
                    >
                        Stop
                    </button>
                )}
            </div>
            {expanded && (
                <div className="shell-step-output">
                    {step.stdout ? <pre className="shell-stdout">{step.stdout}</pre> : null}
                    {step.stderr ? <pre className="shell-stderr">{step.stderr}</pre> : null}
                    {step.durationMs !== undefined ? (
                        <div className="shell-step-meta muted">{step.durationMs}ms</div>
                    ) : null}
                </div>
            )}
        </div>
    );
}
