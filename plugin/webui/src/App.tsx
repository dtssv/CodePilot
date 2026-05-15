import { useEffect, useRef, useState } from 'react';
import { onPluginEvent, sendToPlugin } from './bridge';
import { AgentStep } from './components/AgentStepCard';
import { ChatView } from './components/ChatView';
import { ComposerPanel } from './components/ComposerPanel';
import { ConsoleEntry, ConsolePanel } from './components/ConsolePanel';
import ContextBudgetBar from './components/ContextBudgetBar';
import { ContextChipData } from './components/ContextChip';
import { ImageData } from './components/ImageAttachment';
import { InputBar } from './components/InputBar';
import { LoginPage } from './components/LoginPage';
import { MarketplacePanel } from './components/MarketplacePanel';
import { ModelSelector } from './components/ModelSelector';
import { MultiFileDiffPanel } from './components/MultiFileDiffPanel';
import { NotepadsPanel } from './components/NotepadsPanel';
import { SessionCostInfo, SessionCostPanel } from './components/SessionCostPanel';
import { SessionInfo, SessionSidebar } from './components/SessionSidebar';

interface ModelOption {
    id: string;
    name: string;
    type: 'system' | 'custom';
}

export interface ToolCallInfo {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status?: 'running' | 'success' | 'error';
}

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    contextRefs?: { display: string; type?: string }[];
    toolCall?: { id: string; name: string; args: unknown };
    /** Tool calls attached to an assistant message (rendered as inline cards) */
    toolCalls?: ToolCallInfo[];
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: { title?: string; questions?: { id: string; prompt: string; kind?: string; options?: { id: string; label: string }[] }[]; continuationToken?: string };
    diff?: { path: string; hunks: string };
    // ★ Image attachments for multi-modal
    images?: { url: string; mimeType?: string; description?: string }[];
    /** Agent interactive steps (thinking/reading/writing/running) */
    agentSteps?: AgentStep[];
    /** Plan steps shown in the response (from user_plan event) */
    planSteps?: { id: string; title: string; status: string }[];
    _streaming?: boolean;
    /** Timestamp for the message */
    ts?: string;
}

interface BranchInfo {
    branchId: string;
    sessionId: string;
    parentBranchId: string | null;
    forkMsgIndex: number | null;
}

export function App() {
    const [authenticated, setAuthenticated] = useState(false);
    const [mode, setMode] = useState<'agent' | 'chat'>('agent');
    const [activeTab, setActiveTab] = useState<'chat' | 'composer' | 'marketplace' | 'notepads' | 'console'>('chat');
    const [models, setModels] = useState<ModelOption[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string>('');
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [contextChips, setContextChips] = useState<ContextChipData[]>([]);
    const [contextTokens, setContextTokens] = useState(0);
    const [totalTokens, setTotalTokens] = useState(128000); // Default to 128k
    const [estimatedTokens, setEstimatedTokens] = useState(0);
    const [theme, setTheme] = useState<'dark' | 'light' | 'high-contrast'>('dark');
    const [branches, setBranches] = useState<BranchInfo[]>([]);
    const [activeBranchId, setActiveBranchId] = useState<string>('main');
    // ★ Session cost tracking
    const [sessionCost, setSessionCost] = useState<SessionCostInfo>({
        messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0,
    });
    // ★ Session recovery state
    const [abnormalTermination, setAbnormalTermination] = useState(false);
    const [hasCheckpoint, setHasCheckpoint] = useState(false);
    const [isResuming, setIsResuming] = useState(false);
    // ★ Auto-apply patches setting
    const [autoApply, setAutoApply] = useState(false);
    // ★ Pending file changes (for change list panel)
    const [pendingChanges, setPendingChanges] = useState<{ path: string; op: string; toolCallId: string }[]>([]);
    // ★ Console log entries
    const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
    const consoleIdRef = useRef(0);
    const historyBtnRef = useRef<HTMLButtonElement>(null);
    // ★ Track whether we're in an active reply (from user send → done with reason=final)
    // This ensures all delta/tool_call/agent events within one request are merged into ONE assistant message
    const activeReplyRef = useRef(false);

    // Console logging helper
    const logConsole = (type: ConsoleEntry['type'], source: string, data: unknown) => {
        const entry: ConsoleEntry = {
            id: `console-${++consoleIdRef.current}`,
            timestamp: new Date(),
            type,
            source,
            data,
        };
        setConsoleEntries(prev => [...prev.slice(-500), entry]); // Keep last 500 entries
    };

    // Apply theme to document root
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    // Listen for IDE theme changes via plugin
    useEffect(() => {
        const unsub = onPluginEvent('ide_theme', (payload) => {
            const ideTheme = (payload as { theme: string }).theme;
            if (ideTheme === 'light') setTheme('light');
            else if (ideTheme === 'high-contrast') setTheme('high-contrast');
            else setTheme('dark');
        });
        return unsub;
    }, []);

    // Check auth state on mount and listen for changes
    useEffect(() => {
        // Ask the plugin for current auth state
        sendToPlugin('check_auth', {}).catch(() => { });

        const unsubs = [
            onPluginEvent('auth_state', (payload) => {
                const state = payload as { authenticated: boolean };
                setAuthenticated(state.authenticated);
            }),
            onPluginEvent('auth_login_result', (payload) => {
                const result = payload as { success: boolean };
                if (result.success) {
                    setAuthenticated(true);
                    // Fetch models and session list after login
                    sendToPlugin('fetch_models', {}).catch(() => { });
                    sendToPlugin('list_sessions', {}).catch(() => { });
                }
            }),
        ];
        return () => unsubs.forEach(u => u());
    }, []);

    useEffect(() => {
        if (!authenticated) return;
        sendToPlugin('fetch_models', {});
        sendToPlugin('list_sessions', {});

        const unsubs = [
            onPluginEvent('models_loaded', (payload) => {
                const data = payload as { system?: ModelOption[]; custom?: ModelOption[] };
                const all: ModelOption[] = [
                    ...(data.system || []).map((m) => ({ ...m, type: 'system' as const })),
                    ...(data.custom || []).map((m) => ({ ...m, type: 'custom' as const })),
                ];
                setModels(all);
                if (!selectedModelId && all.length > 0) {
                    setSelectedModelId(all[0].id);
                }
            }),
            // Session list updates
            onPluginEvent('session_list', (payload) => {
                const data = payload as { sessions: SessionInfo[]; activeSessionId: string };
                setSessions(data.sessions);
                setActiveSessionId(data.activeSessionId);
            }),
            // Session switched — reset messages and chips
            onPluginEvent('session_switched', (payload) => {
                const data = payload as { id: string };
                setActiveSessionId(data.id);
                setMessages([]);
                setContextChips([]);
                setAbnormalTermination(false);
                setHasCheckpoint(false);
                activeReplyRef.current = false;
            }),
            // Branch list update
            onPluginEvent('branch_list', (payload) => {
                const data = payload as { branches: BranchInfo[]; activeBranchId: string };
                setBranches(data.branches);
                setActiveBranchId(data.activeBranchId);
            }),
            // Restore messages from local store
            onPluginEvent('session_messages', (payload) => {
                const data = payload as { messages: ChatMessage[]; abnormalTermination?: boolean; hasCheckpoint?: boolean };
                // Restore messages with toolCalls data preserved
                const restoredMessages = data.messages.map((msg: ChatMessage) => ({
                    ...msg,
                    // Ensure toolCalls from persisted data are properly typed
                    toolCalls: msg.toolCalls?.map((tc: any) => ({
                        id: tc.id || '',
                        name: tc.name || 'unknown',
                        args: tc.args || {},
                        status: tc.status || 'success',
                    })),
                }));
                setMessages(restoredMessages);
                // Restore session recovery state
                setAbnormalTermination(data.abnormalTermination ?? false);
                setHasCheckpoint(data.hasCheckpoint ?? false);
            }),
            // User message saved from plugin (after persistence)
            onPluginEvent('user_message_saved', (payload) => {
                const msg = payload as { role: string; content: string; contextRefs?: { display: string; type?: string }[] };
                setMessages((prev) => [...prev, {
                    role: 'user' as const,
                    content: msg.content,
                    contextRefs: msg.contextRefs,
                }]);
            }),
            // Streaming delta
            onPluginEvent('delta', (p) => {
                const { text } = p as { text: string };
                logConsole('sse', 'delta', { text: text.substring(0, 100) + (text.length > 100 ? '...' : '') });
                setMessages((prev) => {
                    // ★ During an active reply, ALWAYS append to the last assistant message
                    // This handles multi-phase responses where intermediate "done" events
                    // should NOT split the assistant reply into separate messages.
                    const last = prev[prev.length - 1];
                    if (last && last.role === 'assistant') {
                        return [...prev.slice(0, -1), { ...last, content: last.content + text, _streaming: true }];
                    }
                    // No assistant message yet, or last message is not assistant (e.g. system event)
                    // During active reply, find the last assistant message and append to it
                    if (activeReplyRef.current) {
                        for (let i = prev.length - 1; i >= 0; i--) {
                            if (prev[i].role === 'assistant') {
                                return [...prev.slice(0, i), { ...prev[i], content: prev[i].content + text, _streaming: true }, ...prev.slice(i + 1)];
                            }
                        }
                    }
                    return [...prev, { role: 'assistant' as const, content: text, _streaming: true }];
                });
            }),
            // Done — finalize streaming message and refresh session list
            onPluginEvent('done', (p) => {
                const data = p as { reason?: string };
                logConsole('sse', 'done', data);
                const reason = data.reason || 'final';
                // ★ Only end the active reply on "final" reason.
                // Intermediate done events (subtask_done, phase_done, etc.) should NOT
                // split the assistant reply — the graph execution is still in progress.
                const isFinal = reason === 'final' || reason === 'failed' || reason === 'stopped' || reason === 'max_steps';
                // ★ Defensive: if activeReplyRef is already false (duplicate done event),
                // skip message state update to avoid re-finalizing an already finalized message
                const isActive = activeReplyRef.current;
                if (isActive || !isFinal) {
                    setMessages((prev) => {
                        // ★ Find the last assistant message (may not be the very last if system events were inserted)
                        // and finalize its streaming state
                        let lastAssistantIdx = -1;
                        for (let i = prev.length - 1; i >= 0; i--) {
                            if (prev[i].role === 'assistant') {
                                lastAssistantIdx = i;
                                break;
                            }
                        }
                        if (lastAssistantIdx < 0) return prev;
                        const last = prev[lastAssistantIdx];
                        const finalizedSteps = last.agentSteps?.map(s => s.status === 'running' ? { ...s, status: 'success' as const } : s);
                        const updated = [...prev];
                        updated[lastAssistantIdx] = {
                            ...last,
                            _streaming: false,
                            agentSteps: finalizedSteps || last.agentSteps,
                        };
                        return updated;
                    });
                }
                if (isFinal) {
                    activeReplyRef.current = false;
                    // Clear abnormal termination state on successful completion
                    setAbnormalTermination(false);
                    setHasCheckpoint(false);
                    setIsResuming(false);
                    // Refresh session list to update lastMessageAt timestamp
                    sendToPlugin('list_sessions', {}).catch(() => { });
                }
            }),
            onPluginEvent('tool_call', (p) => {
                const tc = p as { id?: string; toolCallId?: string; name?: string; tool?: string; args: unknown };
                logConsole('tool', 'tool_call', tc);
                const toolName = tc.name || tc.tool || 'unknown';
                const toolCallId = tc.id || tc.toolCallId || '';
                const toolCallInfo: ToolCallInfo = {
                    id: toolCallId,
                    name: toolName,
                    args: (tc.args || {}) as Record<string, unknown>,
                    status: 'running',
                };
                // ★ Extract pending changes from write-category tool calls
                if (toolName.startsWith('fs.write') || toolName.startsWith('fs.create') || toolName.startsWith('fs.replace') || toolName.startsWith('fs.applyPatch') || toolName.startsWith('fs.delete')) {
                    const rawArgs = (tc.args || {}) as Record<string, unknown>;
                    // Handle patches array format
                    const patches = rawArgs.patches as { path?: string; op?: string }[] | undefined;
                    if (patches && Array.isArray(patches)) {
                        const newChanges = patches.map(p => ({ path: p.path || '', op: p.op || 'replace', toolCallId }));
                        setPendingChanges(prev => [...prev, ...newChanges]);
                    } else {
                        const path = (rawArgs.path as string) || '';
                        const op = (rawArgs.op as string) || toolName.replace('fs.', '') || 'write';
                        if (path) {
                            setPendingChanges(prev => [...prev, { path, op, toolCallId }]);
                        }
                    }
                }
                setMessages((msgs) => {
                    // ★ During active reply, always append tool call to the last assistant message
                    // This ensures tool calls across graph phases are merged into ONE assistant message
                    let lastAssistantIdx = -1;
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        if (msgs[i].role === 'assistant') {
                            lastAssistantIdx = i;
                            break;
                        }
                    }
                    if (lastAssistantIdx >= 0) {
                        const last = msgs[lastAssistantIdx];
                        const updated = [...msgs];
                        updated[lastAssistantIdx] = {
                            ...last,
                            toolCalls: [...(last.toolCalls || []), toolCallInfo],
                        };
                        return updated;
                    }
                    // No assistant message yet — create one with the tool call
                    return [
                        ...msgs,
                        { role: 'assistant' as const, content: '', toolCalls: [toolCallInfo] },
                    ];
                });
            }),
            onPluginEvent('tool_result_ack', (p) => {
                const ack = p as { toolCallId?: string; ok?: boolean };
                logConsole('tool', 'tool_result_ack', ack);
                const ackId = ack.toolCallId || '';
                if (!ackId) return;
                // ★ Remove completed changes from pending list
                setPendingChanges(prev => prev.filter(c => c.toolCallId !== ackId));
                setMessages((msgs) => {
                    // Find the assistant message that contains this toolCall and update its status
                    let assistantIdx = -1;
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        if (msgs[i].role === 'assistant' && msgs[i].toolCalls?.some((tc) => tc.id === ackId)) {
                            assistantIdx = i; break;
                        }
                    }
                    if (assistantIdx < 0) return msgs;
                    const updated = [...msgs];
                    const existing = updated[assistantIdx];
                    updated[assistantIdx] = {
                        ...existing,
                        toolCalls: existing.toolCalls?.map((tc) =>
                            tc.id === ackId ? { ...tc, status: ack.ok ? 'success' : 'error' } : tc),
                    };
                    return updated;
                });
            }),
            onPluginEvent('risk_notice', (p) => {
                const rn = p as { level: string; message: string; filesPaths: string[] };
                setMessages((msgs) => {
                    // ★ During active reply, attach risk notice to the last assistant message
                    // instead of inserting a separate system message that would split the reply
                    if (activeReplyRef.current) {
                        let lastAssistantIdx = -1;
                        for (let i = msgs.length - 1; i >= 0; i--) {
                            if (msgs[i].role === 'assistant') { lastAssistantIdx = i; break; }
                        }
                        if (lastAssistantIdx >= 0) {
                            const last = msgs[lastAssistantIdx];
                            // Merge risk notice into the assistant message's content
                            const updated = [...msgs];
                            updated[lastAssistantIdx] = {
                                ...last,
                                content: last.content + `\n\n⚠️ **Risk Notice (${rn.level})**: ${rn.message}${(rn.filesPaths && rn.filesPaths.length > 0) ? `\nFiles: ${rn.filesPaths.join(', ')}` : ''}`,
                            };
                            return updated;
                        }
                    }
                    return [...msgs, { role: 'system', content: '', riskNotice: rn }];
                });
            }),
            onPluginEvent('needs_input', (p) => {
                // Backend format: { title, questions: [{ id, prompt, kind, options: [{ id, label }] }], continuationToken }
                const ni = p as {
                    title?: string;
                    questions?: { id: string; prompt: string; kind?: string; options?: { id: string; label: string }[] }[];
                    continuationToken?: string;
                };
                const questionText = ni.title || (ni.questions && ni.questions.length > 0 ? ni.questions[0].prompt : '');
                const optionsText = ni.questions && ni.questions.length > 0 && ni.questions[0].options
                    ? ni.questions[0].options.map(o => o.label || o.id).join(' / ')
                    : '';
                setMessages((msgs) => {
                    // ★ During active reply, attach needs_input to the last assistant message
                    if (activeReplyRef.current) {
                        let lastAssistantIdx = -1;
                        for (let i = msgs.length - 1; i >= 0; i--) {
                            if (msgs[i].role === 'assistant') { lastAssistantIdx = i; break; }
                        }
                        if (lastAssistantIdx >= 0) {
                            const last = msgs[lastAssistantIdx];
                            const updated = [...msgs];
                            updated[lastAssistantIdx] = {
                                ...last,
                                content: last.content + `\n\n❓ **${questionText}**${optionsText ? `\nOptions: ${optionsText}` : ''}`,
                            };
                            return updated;
                        }
                    }
                    return [...msgs, { role: 'system', content: '', needsInput: ni }];
                });
            }),
            onPluginEvent('error', (p) => {
                const err = p as { code: number; message: string };
                logConsole('error', 'error', err);
                setMessages((msgs) => {
                    // ★ During active reply, attach error to the last assistant message
                    if (activeReplyRef.current) {
                        let lastAssistantIdx = -1;
                        for (let i = msgs.length - 1; i >= 0; i--) {
                            if (msgs[i].role === 'assistant') { lastAssistantIdx = i; break; }
                        }
                        if (lastAssistantIdx >= 0) {
                            const last = msgs[lastAssistantIdx];
                            const updated = [...msgs];
                            updated[lastAssistantIdx] = {
                                ...last,
                                content: last.content + `\n\n❌ **Error**: ${err.message}`,
                            };
                            return updated;
                        }
                    }
                    return [...msgs, { role: 'system', content: `Error: ${err.message}` }];
                });
            }),
            // Action start — show compact action label in the chat
            onPluginEvent('action_start', (p) => {
                const data = p as { action: string; display: string; instruction: string };
                // ★ During an active reply (SSE stream), do NOT insert a new user message
                // as it would split the assistant reply into separate messages.
                // The action context is already visible via agent steps in the assistant message.
                if (activeReplyRef.current) return;
                setMessages((prev) => [
                    ...prev,
                    { role: 'user' as const, content: `**${data.display}**\n${data.instruction}` },
                ]);
            }),
            // Action done
            onPluginEvent('action_done', () => {
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && last._streaming) {
                        return [...prev.slice(0, -1), { ...last, _streaming: false }];
                    }
                    return prev;
                });
            }),
            // Context added from right-click "Add to Chat" — creates a chip (NOT a message)
            onPluginEvent('context_added', (p) => {
                const data = p as {
                    id: string;
                    type: 'code' | 'file' | 'package';
                    display: string;
                    filePath: string;
                    language: string;
                    startLine: number | null;
                    endLine: number | null;
                };
                const chip: ContextChipData = {
                    id: data.id,
                    type: data.type,
                    display: data.display,
                    filePath: data.filePath,
                    language: data.language,
                    startLine: data.startLine,
                    endLine: data.endLine,
                };
                setContextChips((prev) => [...prev, chip]);
            }),
            // Context budget updates
            onPluginEvent('context_budget', (p) => {
                const data = p as { current: number; total: number; estimated: number };
                setContextTokens(data.current);
                setTotalTokens(data.total);
                setEstimatedTokens(data.estimated);
            }),
            // Patch from actions
            onPluginEvent('patch', (p) => {
                const patchData = p as { files: unknown; hunks: unknown };
                // ★ During active reply, don't insert a separate system message
                if (activeReplyRef.current) return;
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: 'Patch generated', diff: { path: '', hunks: JSON.stringify(patchData) } },
                ]);
            }),
            // ★ Session cost updates
            onPluginEvent('session_cost', (p) => {
                const data = p as SessionCostInfo;
                setSessionCost(data);
            }),
            // ★ Session interrupted (abnormal termination)
            onPluginEvent('session_interrupted', (p) => {
                const data = p as { sessionId: string; hasCheckpoint: boolean };
                activeReplyRef.current = false;
                setAbnormalTermination(true);
                setHasCheckpoint(data.hasCheckpoint);
                setIsResuming(false);
                // Finalize any streaming message
                setMessages((prev) => {
                    let lastAssistantIdx = -1;
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') { lastAssistantIdx = i; break; }
                    }
                    if (lastAssistantIdx >= 0 && prev[lastAssistantIdx]._streaming) {
                        const updated = [...prev];
                        updated[lastAssistantIdx] = { ...prev[lastAssistantIdx], _streaming: false };
                        return updated;
                    }
                    return prev;
                });
            }),
            // ★ Session resuming
            onPluginEvent('session_resuming', () => {
                activeReplyRef.current = true;
                setIsResuming(true);
            }),
            // ★ Auto-apply state sync from plugin
            onPluginEvent('auto_apply_state', (payload) => {
                const data = payload as { enabled: boolean };
                setAutoApply(data.enabled);
            }),
            // ★ Pending changes sync from plugin
            onPluginEvent('pending_changes', (payload) => {
                const data = payload as { changes: { path: string; op: string; toolCallId: string }[] };
                setPendingChanges(data.changes);
            }),
            // ★ Console log from plugin (e.g., HTTP request/response)
            onPluginEvent('console_log', (payload) => {
                const data = payload as { type?: string; source?: string; data?: unknown };
                logConsole(data.type as ConsoleEntry['type'] || 'info', data.source || 'plugin', data.data);
            }),
            // ★ Agent interactive steps — thinking/reading/writing/running
            onPluginEvent('agent_thinking', (payload) => {
                const data = payload as { text?: string; phaseId?: string };
                logConsole('agent', 'agent_thinking', data);
                const step: AgentStep = { type: 'thinking', content: data.text || '思考中...', status: 'running' };
                setMessages((prev) => {
                    // ★ Find the last assistant message (not necessarily the very last element)
                    let lastAssistantIdx = -1;
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') { lastAssistantIdx = i; break; }
                    }
                    if (lastAssistantIdx >= 0) {
                        const last = prev[lastAssistantIdx];
                        const updated = [...prev];
                        updated[lastAssistantIdx] = { ...last, agentSteps: [...(last.agentSteps || []), step] };
                        return updated;
                    }
                    return [...prev, { role: 'assistant' as const, content: '', agentSteps: [step] }];
                });
            }),
            onPluginEvent('agent_reading', (payload) => {
                const data = payload as { summary?: string; files?: { path: string; op?: string }[]; phaseId?: string };
                logConsole('agent', 'agent_reading', data);
                // Mark previous thinking step as success
                setMessages((prev) => {
                    let lastAssistantIdx = -1;
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') { lastAssistantIdx = i; break; }
                    }
                    if (lastAssistantIdx >= 0) {
                        const last = prev[lastAssistantIdx];
                        if (last.agentSteps && last.agentSteps.length > 0) {
                            const steps = [...last.agentSteps];
                            const lastStep = steps[steps.length - 1];
                            if (lastStep.type === 'thinking' && lastStep.status === 'running') {
                                steps[steps.length - 1] = { ...lastStep, status: 'success' };
                            }
                            const readingStep: AgentStep = {
                                type: 'reading',
                                content: data.summary || '读取文件',
                                status: 'success',
                                detail: { files: (data.files || []).map(f => ({ path: f.path, op: f.op })), summary: data.summary },
                            };
                            const updated = [...prev];
                            updated[lastAssistantIdx] = { ...last, agentSteps: [...steps, readingStep] };
                            return updated;
                        }
                    }
                    const readingStep: AgentStep = {
                        type: 'reading',
                        content: data.summary || '读取文件',
                        status: 'success',
                        detail: { files: (data.files || []).map(f => ({ path: f.path, op: f.op })), summary: data.summary },
                    };
                    return [...prev, { role: 'assistant' as const, content: '', agentSteps: [readingStep] }];
                });
            }),
            onPluginEvent('agent_writing', (payload) => {
                const data = payload as { text?: string; files?: { path: string; op?: string; lineCount?: number; preview?: string }[]; phaseId?: string };
                logConsole('agent', 'agent_writing', data);
                // Mark previous thinking step as success
                setMessages((prev) => {
                    let lastAssistantIdx = -1;
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') { lastAssistantIdx = i; break; }
                    }
                    if (lastAssistantIdx >= 0) {
                        const last = prev[lastAssistantIdx];
                        if (last.agentSteps && last.agentSteps.length > 0) {
                            const steps = [...last.agentSteps];
                            const lastStep = steps[steps.length - 1];
                            if (lastStep.type === 'thinking' && lastStep.status === 'running') {
                                steps[steps.length - 1] = { ...lastStep, status: 'success' };
                            }
                            const writingStep: AgentStep = {
                                type: 'writing',
                                content: data.text || '修改文件',
                                status: 'running',
                                detail: { files: data.files || [] },
                            };
                            const updated = [...prev];
                            updated[lastAssistantIdx] = { ...last, agentSteps: [...steps, writingStep] };
                            return updated;
                        }
                    }
                    const writingStep: AgentStep = {
                        type: 'writing',
                        content: data.text || '修改文件',
                        status: 'running',
                        detail: { files: data.files || [] },
                    };
                    return [...prev, { role: 'assistant' as const, content: '', agentSteps: [writingStep] }];
                });
            }),
            onPluginEvent('agent_running', (payload) => {
                const data = payload as { text?: string; command?: string; output?: string; phaseId?: string };
                logConsole('agent', 'agent_running', data);
                // Mark previous writing step as success
                setMessages((prev) => {
                    let lastAssistantIdx = -1;
                    for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') { lastAssistantIdx = i; break; }
                    }
                    if (lastAssistantIdx >= 0) {
                        const last = prev[lastAssistantIdx];
                        if (last.agentSteps && last.agentSteps.length > 0) {
                            const steps = [...last.agentSteps];
                            const lastStep = steps[steps.length - 1];
                            if (lastStep.type === 'writing' && lastStep.status === 'running') {
                                steps[steps.length - 1] = { ...lastStep, status: 'success' };
                            }
                            const runningStep: AgentStep = {
                                type: 'running',
                                content: data.text || '运行命令',
                                status: 'running',
                                detail: { command: data.command, output: data.output },
                            };
                            const updated = [...prev];
                            updated[lastAssistantIdx] = { ...last, agentSteps: [...steps, runningStep] };
                            return updated;
                        }
                    }
                    const runningStep: AgentStep = {
                        type: 'running',
                        content: data.text || '运行命令',
                        status: 'running',
                        detail: { command: data.command, output: data.output },
                    };
                    return [...prev, { role: 'assistant' as const, content: '', agentSteps: [runningStep] }];
                });
            }),
            // ★ Plan steps from backend — store in current assistant message
            onPluginEvent('user_plan', (payload) => {
                const data = payload as { goal?: string; steps?: { id: string; title: string; status?: string }[] };
                logConsole('agent', 'user_plan', data);
                if (data.steps && data.steps.length > 0) {
                    const planSteps = data.steps.map(s => ({
                        id: s.id,
                        title: s.title,
                        status: s.status || 'pending',
                    }));
                    setMessages((prev) => {
                        let lastAssistantIdx = -1;
                        for (let i = prev.length - 1; i >= 0; i--) {
                            if (prev[i].role === 'assistant') { lastAssistantIdx = i; break; }
                        }
                        if (lastAssistantIdx >= 0) {
                            const last = prev[lastAssistantIdx];
                            const updated = [...prev];
                            updated[lastAssistantIdx] = { ...last, planSteps };
                            return updated;
                        }
                        return [...prev, { role: 'assistant' as const, content: '', planSteps }];
                    });
                }
            }),
        ];
        return () => unsubs.forEach((u) => u());
    }, [authenticated]);

    const handleSend = (text: string, chips: ContextChipData[], images?: ImageData[]) => {
        // ★ Mark the start of an active reply — all subsequent delta/tool_call/agent events
        // will be merged into ONE assistant message until done(reason=final)
        activeReplyRef.current = true;

        // Build contextRefs for the plugin (no fullCode — that's in Kotlin contextStore)
        const contextRefs = chips.map((chip) => ({
            id: chip.id,
            display: chip.display,
            type: chip.type,
            filePath: chip.filePath,
            language: chip.language,
            startLine: chip.startLine,
            endLine: chip.endLine,
        }));

        // ★ Build conversation history from current messages for context continuity
        // Only include user and assistant messages (skip system messages)
        // Trim content to reasonable length to avoid excessive token usage
        const historyMessages = messages
            .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
            .map((msg) => ({
                role: msg.role,
                // Truncate long messages to keep context within budget
                content: msg.content.length > 4000 ? msg.content.substring(0, 4000) + '...' : msg.content,
            }));

        const msgPayload = {
            text,
            contextRefs,
            mode,
            modelId: selectedModelId || undefined,
            modelSource: selectedModelId ? (models.find(m => m.id === selectedModelId)?.type === 'custom' ? 'custom' : 'group') : undefined,
            images: images?.map(img => ({ name: img.name, mimeType: img.mimeType, base64: img.base64 })),
            // ★ Pass conversation history for multi-turn context
            historyMessages,
        };
        logConsole('bridge', 'sendToPlugin:user_message', { text: text.substring(0, 100), mode, contextRefsCount: contextRefs.length, historyCount: historyMessages.length });
        sendToPlugin('user_message', msgPayload);
        // Clear chips after send
        setContextChips([]);
    };

    const handleStop = () => {
        sendToPlugin('stop', {});
    };

    const handleNewSession = () => {
        sendToPlugin('new_session', {});
        setHistoryOpen(false);
        // Immediately clear local state
        setMessages([]);
        setContextChips([]);
        setAbnormalTermination(false);
        setHasCheckpoint(false);
        setIsResuming(false);
        activeReplyRef.current = false;
    };

    const handleSelectSession = (id: string) => {
        if (id !== activeSessionId) {
            sendToPlugin('switch_session', { sessionId: id });
        }
        setHistoryOpen(false);
    };

    const handleDeleteSession = (id: string) => {
        sendToPlugin('delete_session', { sessionId: id });
    };

    const handleRemoveChip = (id: string) => {
        setContextChips((prev) => prev.filter((c) => c.id !== id));
    };

    // Close history popup when clicking outside
    useEffect(() => {
        if (!historyOpen) return;
        const handler = (e: MouseEvent) => {
            const popup = document.querySelector('.history-popup');
            const btn = historyBtnRef.current;
            if (popup && !popup.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
                setHistoryOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [historyOpen]);

    // Show login page if not authenticated
    if (!authenticated) {
        return <LoginPage />;
    }

    return (
        <div className="app-layout">
            <div className="main-area">
                {/* Top bar with history button */}
                <div className="top-bar">
                    <button
                        ref={historyBtnRef}
                        className="history-btn"
                        onClick={() => setHistoryOpen(!historyOpen)}
                        title="Chat history"
                    >
                        ☰ History
                    </button>
                    <button
                        className="new-chat-btn-top"
                        onClick={handleNewSession}
                        title="New chat"
                    >
                        + New Chat
                    </button>
                </div>

                {/* History popup */}
                {historyOpen && (
                    <div className="history-popup">
                        <SessionSidebar
                            sessions={sessions}
                            activeSessionId={activeSessionId}
                            onSelect={handleSelectSession}
                            onNew={handleNewSession}
                            onDelete={handleDeleteSession}
                        />
                    </div>
                )}

                <div className="chat-area">
                    {/* ★ Abnormal termination recovery banner */}
                    {activeTab === 'chat' && abnormalTermination && !isResuming && (
                        <div className="session-recovery-banner">
                            <div className="recovery-banner-content">
                                <span className="recovery-icon">⚠️</span>
                                <span className="recovery-text">上次任务异常中断</span>
                                {hasCheckpoint && (
                                    <button
                                        className="recovery-btn"
                                        onClick={() => {
                                            setIsResuming(true);
                                            sendToPlugin('resume_session', {});
                                        }}
                                    >
                                        恢复任务
                                    </button>
                                )}
                                <button
                                    className="recovery-dismiss-btn"
                                    onClick={() => {
                                        setAbnormalTermination(false);
                                    }}
                                >
                                    忽略
                                </button>
                            </div>
                        </div>
                    )}
                    {activeTab === 'chat' && isResuming && (
                        <div className="session-resuming-banner">
                            <span className="resuming-spinner" />
                            <span className="resuming-text">正在恢复任务...</span>
                        </div>
                    )}
                    {/* ★ Pending changes panel */}
                    {activeTab === 'chat' && pendingChanges.length > 0 && (
                        <div className="pending-changes-panel">
                            <div className="pending-changes-header">
                                <span className="pending-changes-title">待变更文件 ({pendingChanges.length})</span>
                                <div className="pending-changes-actions">
                                    <button className="pending-changes-apply-btn" onClick={() => sendToPlugin('apply_patches', {})}>
                                        全部应用
                                    </button>
                                    <button className="pending-changes-dismiss-btn" onClick={() => setPendingChanges([])}>
                                        清除列表
                                    </button>
                                </div>
                            </div>
                            <div className="pending-changes-list">
                                {pendingChanges.map((c, idx) => (
                                    <div key={`${c.toolCallId}-${idx}`} className="pending-change-item">
                                        <span className="pending-change-icon">{c.op === 'create' ? '✨' : c.op === 'delete' ? '🗑️' : '📝'}</span>
                                        <span className="pending-change-op">{c.op === 'create' ? '创建' : c.op === 'delete' ? '删除' : c.op === 'replace' ? '替换' : '修改'}</span>
                                        <span className="pending-change-path">{c.path.split('/').pop() || c.path}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {activeTab === 'chat' && <ChatView messages={messages} onForkFromMessage={(idx) => sendToPlugin('fork_from_message', { messageIndex: idx })} />}
                    {activeTab === 'composer' && <ComposerPanel />}
                    {activeTab === 'marketplace' && <MarketplacePanel />}
                    {activeTab === 'notepads' && <NotepadsPanel />}
                    {activeTab === 'console' && <ConsolePanel entries={consoleEntries} onClear={() => setConsoleEntries([])} />}
                    {/* ★ Agent plan & multi-file diff panels (auto-visible when data arrives) */}

                    <MultiFileDiffPanel />
                </div>
                <div className="input-section">
                    {activeTab === 'chat' && (
                        <>
                            <ContextBudgetBar
                                currentTokens={contextTokens}
                                totalTokens={totalTokens}
                                estimatedTokens={estimatedTokens}
                                onCompress={() => sendToPlugin('compress_context', {})}
                            />
                            {/* ★ Session cost panel */}
                            <SessionCostPanel costInfo={sessionCost} />
                            <InputBar onSend={handleSend} onStop={handleStop} contextChips={contextChips} onRemoveChip={handleRemoveChip} />
                            <div className="input-bottom-row">
                                <select className="opt-select" value={mode} onChange={(e) => setMode(e.target.value as 'agent' | 'chat')}>
                                    <option value="agent">Agent</option>
                                    <option value="chat">Chat</option>
                                </select>
                                <ModelSelector
                                    models={models}
                                    selectedModelId={selectedModelId}
                                    onSelect={setSelectedModelId}
                                />
                                {mode === 'agent' && (
                                    <label className="auto-apply-toggle" title="自动应用低风险文件变更">
                                        <input
                                            type="checkbox"
                                            checked={autoApply}
                                            onChange={(e) => {
                                                const enabled = e.target.checked;
                                                setAutoApply(enabled);
                                                sendToPlugin('update_auto_apply', { enabled });
                                            }}
                                        />
                                        <span className="auto-apply-label">自动写入</span>
                                    </label>
                                )}
                            </div>
                            {branches.length > 1 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>分支:</span>
                                    <select className="opt-select" value={activeBranchId}
                                        onChange={(e) => {
                                            setActiveBranchId(e.target.value);
                                            const branch = branches.find(b => b.branchId === e.target.value);
                                            if (branch) sendToPlugin('switch_branch', { sessionId: branch.sessionId });
                                        }}>
                                        {branches.map(b => (
                                            <option key={b.branchId} value={b.branchId}>
                                                {b.branchId}{b.parentBranchId ? ` (fork from ${b.parentBranchId})` : ''}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </>
                    )}
                    <div className="tab-bar">
                        <button className={activeTab === 'chat' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('chat')}>Chat</button>
                        <button className={activeTab === 'composer' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('composer')}>Composer</button>
                        <button className={activeTab === 'marketplace' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('marketplace')}>Marketplace</button>
                        <button className={activeTab === 'notepads' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('notepads')}>Notepads</button>
                        <button className={activeTab === 'console' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('console')}>Console</button>
                        <button className="tab-btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : t === 'light' ? 'high-contrast' : 'dark')} title="切换主题">
                            {theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '◐'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
