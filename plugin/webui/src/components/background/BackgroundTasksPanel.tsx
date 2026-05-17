import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';

interface BgTask {
    id: string;
    title: string;
    prompt: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    worktreePath: string;
    branchName: string;
    createdAt: number;
    endedAt?: number;
    outputs?: { commits?: string[]; diffStat?: string; prUrl?: string; logPath?: string };
}

export function BackgroundTasksPanel() {
    const [tasks, setTasks] = useState<BgTask[]>([]);
    const [title, setTitle] = useState('');
    const [prompt, setPrompt] = useState('');
    const [logs, setLogs] = useState<Record<string, string[]>>({});

    useEffect(() => {
        const offTasks = onPluginEvent('bg.tasks.update', (payload) => {
            setTasks(((payload as { tasks?: BgTask[] }).tasks ?? []));
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

    const submit = () => {
        if (!prompt.trim()) return;
        sendToPlugin('bg.submit', { title, prompt }).catch(() => undefined);
        setTitle('');
        setPrompt('');
    };

    return (
        <div className="background-panel">
            <div className="panel-header">
                <h3>Background Agents</h3>
                <button type="button" onClick={() => sendToPlugin('bg.list', {})}>Refresh</button>
            </div>
            <div className="bg-new-task">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the background task..." />
                <button type="button" onClick={submit}>Start in worktree</button>
            </div>
            {tasks.length === 0 && <div className="muted">No background tasks yet.</div>}
            {tasks.map((task) => (
                <details key={task.id} className={`bg-task status-${task.status}`} open={task.status === 'running'}>
                    <summary>
                        <span className={`bg-status-dot ${task.status}`} />
                        <strong>{task.title}</strong>
                        <span className="muted">{task.status}</span>
                        <span className="muted">{task.branchName}</span>
                    </summary>
                    <div className="bg-task-body">
                        <div><strong>Worktree:</strong> <code>{task.worktreePath}</code></div>
                        <div><strong>Prompt:</strong> {task.prompt}</div>
                        {task.outputs?.diffStat && <pre className="bg-diffstat">{task.outputs.diffStat}</pre>}
                        {task.outputs?.logPath && <div><strong>Log:</strong> <code>{task.outputs.logPath}</code></div>}
                        <div className="bg-actions">
                            {(task.status === 'queued' || task.status === 'running') && (
                                <button type="button" onClick={() => sendToPlugin('bg.cancel', { id: task.id })}>Cancel</button>
                            )}
                            {task.status === 'completed' && (
                                <>
                                    <button type="button" onClick={() => sendToPlugin('bg.merge', { id: task.id, strategy: 'squash' })}>Squash Merge</button>
                                    <button type="button" onClick={() => sendToPlugin('bg.open_worktree', { id: task.id })}>Open Worktree</button>
                                </>
                            )}
                            <button type="button" onClick={() => sendToPlugin('bg.discard', { id: task.id })}>Discard</button>
                        </div>
                        {(logs[task.id]?.length ?? 0) > 0 && (
                            <pre className="bg-log">{logs[task.id].join('\n')}</pre>
                        )}
                    </div>
                </details>
            ))}
        </div>
    );
}
