import { useEffect, useRef, useState } from 'react';
import { onPluginEvent, sendToPlugin } from './bridge';
import { ChatView } from './components/ChatView';
import { ComposerPanel } from './components/ComposerPanel';
import ContextBudgetBar from './components/ContextBudgetBar';
import { ContextChipData } from './components/ContextChip';
import { InputBar } from './components/InputBar';
import { LoginPage } from './components/LoginPage';
import { MarketplacePanel } from './components/MarketplacePanel';
import { NotepadsPanel } from './components/NotepadsPanel';
import { SessionInfo, SessionSidebar } from './components/SessionSidebar';
import { ImageData } from './components/ImageAttachment';
import { SessionCostPanel, SessionCostInfo } from './components/SessionCostPanel';
import { MultiFileDiffPanel } from './components/MultiFileDiffPanel';
import { PlanPanel } from './components/PlanPanel';

interface ModelOption {
    id: string;
    name: string;
    type: 'system' | 'custom';
}

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    contextRefs?: { display: string; type?: string }[];
    toolCall?: { id: string; name: string; args: unknown };
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: { question: string; options: string[] };
    diff?: { path: string; hunks: string };
    // ★ Image attachments for multi-modal
    images?: { url: string; mimeType?: string; description?: string }[];
    _streaming?: boolean;
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
    const [activeTab, setActiveTab] = useState<'chat' | 'composer' | 'marketplace' | 'notepads'>('chat');
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
    const historyBtnRef = useRef<HTMLButtonElement>(null);

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
                    // Fetch models after login
                    sendToPlugin('fetch_models', {}).catch(() => { });
                }
            }),
        ];
        return () => unsubs.forEach(u => u());
    }, []);

    useEffect(() => {
        if (!authenticated) return;
        sendToPlugin('fetch_models', {});

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
            }),
            // Branch list update
            onPluginEvent('branch_list', (payload) => {
                const data = payload as { branches: BranchInfo[]; activeBranchId: string };
                setBranches(data.branches);
                setActiveBranchId(data.activeBranchId);
            }),
            // Restore messages from local store
            onPluginEvent('session_messages', (payload) => {
                const data = payload as { messages: ChatMessage[] };
                setMessages(data.messages);
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
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && last.role === 'assistant' && last._streaming) {
                        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
                    }
                    return [...prev, { role: 'assistant' as const, content: text, _streaming: true }];
                });
            }),
            // Done — finalize streaming message
            onPluginEvent('done', () => {
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && last._streaming) {
                        return [...prev.slice(0, -1), { ...last, _streaming: false }];
                    }
                    return prev;
                });
            }),
            onPluginEvent('tool_call', (p) => {
                const tc = p as { id: string; name: string; args: unknown };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: `Tool: ${tc.name}`, toolCall: tc },
                ]);
            }),
            onPluginEvent('risk_notice', (p) => {
                const rn = p as { level: string; message: string; filesPaths: string[] };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: '', riskNotice: rn },
                ]);
            }),
            onPluginEvent('needs_input', (p) => {
                const ni = p as { question: string; options: string[] };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: '', needsInput: ni },
                ]);
            }),
            onPluginEvent('error', (p) => {
                const err = p as { code: number; message: string };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: `Error: ${err.message}` },
                ]);
            }),
            // Action start — show compact action label in the chat
            onPluginEvent('action_start', (p) => {
                const data = p as { action: string; display: string; instruction: string };
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
        ];
        return () => unsubs.forEach((u) => u());
    }, [authenticated]);

    const handleSend = (text: string, chips: ContextChipData[], images?: ImageData[]) => {
        // Build contextRefs for the plugin (no fullCode — that's in Kotlin contextStore)
        const contextRefs = chips.map((chip) => ({
            id: chip.id,
            display: chip.display,
            language: chip.language,
            startLine: chip.startLine,
            endLine: chip.endLine,
        }));
        sendToPlugin('user_message', {
            text,
            contextRefs,
            mode,
            modelId: selectedModelId || undefined,
            // ★ Pass image attachments to plugin for multi-modal processing
            images: images?.map(img => ({ name: img.name, mimeType: img.mimeType, base64: img.base64 })),
        });
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
                    {activeTab === 'chat' && <ChatView messages={messages} onForkFromMessage={(idx) => sendToPlugin('fork_from_message', { messageIndex: idx })} />}
                    {activeTab === 'composer' && <ComposerPanel />}
                    {activeTab === 'marketplace' && <MarketplacePanel />}
                    {activeTab === 'notepads' && <NotepadsPanel />}
                    {/* ★ Agent plan & multi-file diff panels (auto-visible when data arrives) */}
                    <PlanPanel />
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
                                <select className="opt-select" value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)}>
                                    {models.length === 0 && <option value="">Default</option>}
                                    {models.map((m) => (
                                        <option key={m.id} value={m.id}>{m.name}{m.type === 'custom' ? ' (custom)' : ''}</option>
                                    ))}
                                </select>
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
                        <button className="tab-btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : t === 'light' ? 'high-contrast' : 'dark')} title="切换主题">
                            {theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '◐'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
