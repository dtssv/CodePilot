import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';
import { setBackgroundActiveCount } from '../../state/bgTasksStore';

interface BgTask {
    id: string;
    title: string;
    prompt: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs_input';
    worktreePath: string;
    branchName: string;
    createdAt: number;
    endedAt?: number;
    source?: 'cloud' | 'local';
    outputs?: { commits?: string[]; diffStat?: string; prUrl?: string; logPath?: string };
}

function BgNeedsInputReply({ taskId }: { taskId: string }) {
    const [answer, setAnswer] = useState('');
    const [sent, setSent] = useState(false);

    const submit = () => {
        const text = answer.trim();
        if (!text || sent) return;
        sendToPlugin('bg.respond', { id: taskId, answer: text }).catch(() => undefined);
        setSent(true);
    };

    return (
        <div className="bg-needs-input-reply panel-section">
            <p className="panel-section-title">Agent needs your input</p>
            <textarea
                className="panel-textarea"
                rows={3}
                placeholder="Type your answer to resume this background task…"
                value={answer}
                disabled={sent}
                onChange={(e) => setAnswer(e.target.value)}
            />
            <button type="button" className="panel-btn panel-btn-primary" disabled={sent || !answer.trim()} onClick={submit}>
                {sent ? 'Sent' : 'Send & resume'}
            </button>
        </div>
    );
}

export function BackgroundTasksPanel() {
    const [tasks, setTasks] = useState<BgTask[]>([]);
    const [cloudSync, setCloudSync] = useState(false);
    const [cloudCount, setCloudCount] = useState(0);
    const [persistBackend, setPersistBackend] = useState<'db' | 'file' | null>(null);
    const [title, setTitle] = useState('');
    const [prompt, setPrompt] = useState('');
    const [logs, setLogs] = useState<Record<string, string[]>>({});

    useEffect(() => {
        const offTasks = onPluginEvent('bg.tasks.update', (payload) => {
            const data = payload as {
                tasks?: BgTask[];
                cloudSync?: boolean;
                cloudCount?: number;
                persistBackend?: 'db' | 'file';
            };
            const next = data.tasks ?? [];
            setTasks(next);
            setCloudSync(Boolean(data.cloudSync));
            setCloudCount(data.cloudCount ?? next.filter((t) => t.source === 'cloud').length);
            if (data.persistBackend) setPersistBackend(data.persistBackend);
            setBackgroundActiveCount(
                next.filter((t) => t.status === 'queued' || t.status === 'running' || t.status === 'needs_input').length,
            );
        });
        const offLog = onPluginEvent('bg.log', (payload) => {
            const data = payload as { taskId?: string; eventType?: string; data?: unknown };
            if (!data.taskId) return;
            setLogs((prev) => ({
                ...prev,
                [data.taskId!]: [...(prev[data.taskId!] ?? []), `[${data.eventType}] ${JSON.stringify(data.data)}`].slice(-80),
            }));
        });
        sendToPlugin('bg.list', {}).catch(() => undefined);
        return () => {
            offTasks();
            offLog();
        };
    }, []);

    useEffect(() => {
        const hasActive = tasks.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'needs_input');
        const intervalMs = hasActive ? 8000 : 30000;
        const id = window.setInterval(() => {
            sendToPlugin('bg.list', {}).catch(() => undefined);
        }, intervalMs);
        return () => window.clearInterval(id);
    }, [tasks]);

    const submit = () => {
        if (!prompt.trim()) return;
        sendToPlugin('bg.submit', { title, prompt }).catch(() => undefined);
        setTitle('');
        setPrompt('');
    };

    return (
        <div className="panel-base background-panel">
            <div className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">🤖 Background Agents</h3>
                    <span className="panel-subtitle">
                        Parallel task execution in isolated worktrees
                        {cloudSync
                            ? ` · cloud sync${cloudCount > 0 ? ` (${cloudCount})` : ''}${persistBackend === 'db' ? ' · DB' : persistBackend === 'file' ? ' · file' : ''}`
                            : ''}
                    </span>
                </div>
                <button type="button" className="panel-btn" onClick={() => sendToPlugin('bg.list', {})}>Refresh</button>
            </div>
            <div className="panel-section">
                <input className="panel-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
                <textarea className="panel-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the background task..." />
                <button type="button" className="panel-btn panel-btn-primary" onClick={submit}>Start in worktree</button>
            </div>
            {tasks.length === 0 && <div className="panel-empty">No background tasks yet.</div>}
            {tasks.map((task) => (
                <details key={task.id} className={`panel-details panel-card status-${task.status}`} open={task.status === 'running' || task.status === 'needs_input'}>
                    <summary className="panel-card-header">
                        <span className={`bg-status-dot ${task.status}`} />
                        <strong>{task.title}</strong>
                        <span className="panel-card-meta">
                            {task.status} · {task.branchName}
                            {task.source === 'cloud' && <span className="panel-badge">cloud</span>}
                            {task.status === 'needs_input' && <span className="panel-badge panel-badge-warn">input</span>}
                        </span>
                    </summary>
                    <div className="panel-card-body">
                        <div><strong>Worktree:</strong> <code>{task.worktreePath}</code></div>
                        <div><strong>Prompt:</strong> {task.prompt}</div>
                        {task.status === 'needs_input' && (
                            <BgNeedsInputReply key={`reply-${task.id}-${task.status}`} taskId={task.id} />
                        )}
                        {task.outputs?.diffStat && <pre className="panel-pre">{task.outputs.diffStat}</pre>}
                        {task.outputs?.logPath && <div><strong>Log:</strong> <code>{task.outputs.logPath}</code></div>}
                        <div className="panel-actions">
                            {(task.status === 'queued' || task.status === 'running') && (
                                <button type="button" className="panel-btn panel-btn-danger" onClick={() => sendToPlugin('bg.cancel', { id: task.id })}>Cancel</button>
                            )}
                            {task.status === 'completed' && task.source !== 'cloud' && (
                                <>
                                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => sendToPlugin('bg.merge', { id: task.id, strategy: 'squash' })}>Squash Merge</button>
                                    <button type="button" className="panel-btn" onClick={() => sendToPlugin('bg.open_worktree', { id: task.id })}>Open Worktree</button>
                                </>
                            )}
                            {task.source !== 'cloud' && (
                                <button type="button" className="panel-btn panel-btn-danger" onClick={() => sendToPlugin('bg.discard', { id: task.id })}>Discard</button>
                            )}
                        </div>
                        {(logs[task.id]?.length ?? 0) > 0 && (
                            <pre className="panel-pre">{logs[task.id].join('\n')}</pre>
                        )}
                    </div>
                </details>
            ))}
        </div>
    );
}
