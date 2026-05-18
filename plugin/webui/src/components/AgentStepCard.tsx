import { useState } from 'react';

/**
 * AgentStep represents a single interactive step in the agent's workflow.
 * Unlike ToolCallCard which shows raw tool execution, AgentStepCard shows
 * the agent's thinking, reading, writing, and running actions in a
 * human-friendly format.
 */

export interface AgentStep {
    type: 'thinking' | 'reading' | 'writing' | 'running' | 'checking';
    content: string;
    status?: 'running' | 'success' | 'error';
    detail?: {
        files?: AgentStepFile[];
        command?: string;
        output?: string;
        summary?: string;
    };
}

export interface AgentStepFile {
    path: string;
    op?: string;
    lineCount?: number;
    preview?: string;
}

const STEP_ICONS: Record<AgentStep['type'], string> = {
    thinking: '💡',
    reading: '📂',
    writing: '📝',
    running: '⌨️',
    checking: '🛡️',
};

const STEP_LABELS: Record<AgentStep['type'], string> = {
    thinking: 'CodePilot',
    reading: 'CodePilot 读取了文件',
    writing: 'CodePilot 想要修改文件',
    running: '终端已运行',
    checking: '验证结果',
};

function fileName(path: string): string {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
}

export function AgentStepCard({ step, compact = false }: { step: AgentStep; compact?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const icon = STEP_ICONS[step.type] || '🔧';
    const status = step.status || 'running';

    // For thinking steps: just show the content, no expand
    if (step.type === 'thinking') {
        return (
            <div className={`agent-step agent-step-thinking ${compact ? 'agent-step-compact' : ''}`}>
                <span className="agent-step-icon">{icon}</span>
                <span className="agent-step-content">{step.content}</span>
                {status === 'running' && <span className="agent-step-spinner" />}
            </div>
        );
    }

    // Compact mode: single line
    if (compact) {
        return (
            <div className={`agent-step agent-step-compact agent-step-${step.type} agent-step-${status}`}>
                <span className="agent-step-icon">{icon}</span>
                <span className="agent-step-content">{step.content}</span>
                <span className={`agent-step-status agent-step-status-${status}`}>
                    {status === 'running' && <span className="agent-step-spinner" />}
                    {status === 'success' && '✓'}
                    {status === 'error' && '✗'}
                </span>
            </div>
        );
    }

    // For reading/writing/running: show content with expandable detail
    return (
        <div className={`agent-step agent-step-${step.type} agent-step-${status}`}>
            <div className="agent-step-header" onClick={() => step.detail && setExpanded(!expanded)}>
                <span className="agent-step-icon">{icon}</span>
                <span className="agent-step-label">{STEP_LABELS[step.type]}</span>
                <span className="agent-step-content">{step.content}</span>
                {step.detail && (
                    <button className="agent-step-expand-btn" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
                        {expanded ? '▾' : '▸'}
                    </button>
                )}
                <span className={`agent-step-status agent-step-status-${status}`}>
                    {status === 'running' && <span className="agent-step-spinner" />}
                    {status === 'success' && '✓'}
                    {status === 'error' && '✗'}
                </span>
            </div>

            {expanded && step.detail && (
                <div className="agent-step-detail">
                    {/* File list for reading/writing */}
                    {step.detail.files && step.detail.files.length > 0 && (
                        <div className="agent-step-files">
                            {step.detail.files.map((f, idx) => (
                                <div key={idx} className="agent-step-file">
                                    <span className="agent-step-file-icon">
                                        {f.op === 'create' ? '✨' : f.op === 'delete' ? '🗑️' : '📄'}
                                    </span>
                                    <span className="agent-step-file-name">{fileName(f.path)}</span>
                                    {f.op === 'create' && <span className="agent-step-file-op">(新建)</span>}
                                    {f.lineCount != null && <span className="agent-step-file-lines">+{f.lineCount}行</span>}
                                    {f.preview && (
                                        <pre className="agent-step-file-preview">{f.preview}</pre>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Command for running */}
                    {step.detail.command && (
                        <div className="agent-step-command">
                            <code>$ {step.detail.command}</code>
                        </div>
                    )}

                    {/* Output for running/checking */}
                    {step.detail.output && (
                        <pre className="agent-step-output">{step.detail.output}</pre>
                    )}

                    {/* Summary for reading */}
                    {step.detail.summary && (
                        <div className="agent-step-summary">{step.detail.summary}</div>
                    )}
                </div>
            )}
        </div>
    );
}