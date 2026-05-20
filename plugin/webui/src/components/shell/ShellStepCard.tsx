import { useEffect, useState } from 'react';
import { sendToPlugin } from '../../bridge';
import { useShellAskForStep } from '../../state/shellAskStore';
import { ShellAskBar } from './ShellAskBar';
import { ShellCommandHeader } from './ShellCommandHeader';
import { ShellOutputPreview } from './ShellOutputPreview';

export interface ShellStepState {
    id: string;
    command: string;
    cwd?: string;
    stdout: string;
    stderr: string;
    exitCode?: number;
    durationMs?: number;
    status: 'running' | 'success' | 'error';
    toolCallId?: string;
    startedAt?: number;
}

const LONG_RUN_HINT_MS = 10_000;

export function ShellStepCard({ step, onStop }: { step: ShellStepState; onStop?: () => void }) {
    const [elapsedSec, setElapsedSec] = useState(0);
    const shellAsk = useShellAskForStep(step.id);
    const handleStop = () => {
        sendToPlugin('stop', {}).catch(() => undefined);
        onStop?.();
    };

    useEffect(() => {
        if (step.status !== 'running') {
            return;
        }
        const start = step.startedAt ?? Date.now();
        const tick = () => setElapsedSec(Math.floor((Date.now() - start) / 1000));
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [step.status, step.startedAt]);

    const longRunning = step.status === 'running' && elapsedSec * 1000 >= LONG_RUN_HINT_MS;
    const hasOutput = Boolean(step.stdout?.trim() || step.stderr?.trim());
    const resultRecord = hasOutput || step.exitCode != null
        ? {
            stdout: step.stdout,
            stderr: step.stderr,
            exitCode: step.exitCode,
            durationMs: step.durationMs,
        }
        : undefined;

    return (
        <div className={`shell-step-card shell-step-${step.status}`}>
            <div className="shell-step-header">
                <span className="shell-step-icon">⌨️</span>
                <ShellCommandHeader command={step.command || 'shell'} cwd={step.cwd} />
                <span className={`shell-step-status shell-step-status-${step.status}`}>
                    {step.status === 'running' && !shellAsk && (
                        <>
                            <span className="agent-step-spinner" />
                            <span className="shell-step-elapsed">{elapsedSec}s</span>
                        </>
                    )}
                    {step.status === 'success' && step.exitCode !== undefined && `exit ${step.exitCode}`}
                    {step.status === 'error' && 'failed'}
                </span>
                {shellAsk && <ShellAskBar ask={shellAsk} />}
                {step.status === 'running' && !shellAsk && (
                    <button
                        type="button"
                        className="shell-step-stop panel-btn"
                        onClick={handleStop}
                    >
                        Stop
                    </button>
                )}
            </div>
            {longRunning && (
                <div className="shell-step-long-hint muted" role="status">
                    命令仍在运行中（已 {elapsedSec}s）— 下载或大任务可能需要较长时间，可随时 Stop
                </div>
            )}
            {resultRecord && (
                <ShellOutputPreview
                    result={resultRecord}
                    className="shell-step-output-preview"
                />
            )}
        </div>
    );
}
