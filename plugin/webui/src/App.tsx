import { useEffect, useRef, useState } from 'react';
import { onPluginEvent, sendToPlugin } from './bridge';
import { ChatView } from './components/ChatView';
import { InputBar } from './components/InputBar';
import { LoginPage } from './components/LoginPage';
import { SessionSidebar, SessionInfo } from './components/SessionSidebar';
import { ContextChipData } from './components/ContextChip';
import { MarketplacePanel } from './components/MarketplacePanel';
import { NotepadsPanel } from './components/NotepadsPanel';
import { ComposerPanel } from './components/ComposerPanel';

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
    _streaming?: boolean;
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
    const historyBtnRef = useRef<HTMLButtonElement>(null);

    // Check auth state on mount and listen for changes
    useEffect(() => {
        // Ask the plugin for current auth state
        sendToPlugin('check_auth', {}).catch(() => {});

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
                    sendToPlugin('fetch_models', {}).catch(() => {});
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
                const data = payload as { builtin?: ModelOption[]; custom?: ModelOption[] };
                const all: ModelOption[] = [
                    ...(data.builtin || []).map((m) => ({ ...m, type: 'system' as const })),
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
            // Patch from actions
            onPluginEvent('patch', (p) => {
                const patchData = p as { files: unknown; hunks: unknown };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: 'Patch generated', diff: { path: '', hunks: JSON.stringify(patchData) } },
                ]);
            }),
        ];
        return () => unsubs.forEach((u) => u());
    }, [authenticated]);

    const handleSend = (text: string, chips: ContextChipData[]) => {
        // Build contextRefs for the plugin (no fullCode — that's in Kotlin contextStore)
        const contextRefs = chips.map((chip) => ({
            id: chip.id,
            display: chip.display,
            language: chip.language,
            startLine: chip.startLine,
            endLine: chip.endLine,
        }));
        sendToPlugin('user_message', { text, contextRefs, mode, modelId: selectedModelId || undefined });
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
                    {activeTab === 'chat' && <ChatView messages={messages} />}
                    {activeTab === 'composer' && <ComposerPanel />}
                    {activeTab === 'marketplace' && <MarketplacePanel />}
                    {activeTab === 'notepads' && <NotepadsPanel />}
                </div>
                <div className="input-section">
                    {activeTab === 'chat' && (
                        <>
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
                        </>
                    )}
                    <div className="tab-bar">
                        <button className={activeTab === 'chat' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('chat')}>Chat</button>
                        <button className={activeTab === 'composer' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('composer')}>Composer</button>
                        <button className={activeTab === 'marketplace' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('marketplace')}>Marketplace</button>
                        <button className={activeTab === 'notepads' ? 'tab-active' : 'tab-btn'} onClick={() => setActiveTab('notepads')}>Notepads</button>
                    </div>
                </div>
            </div>
        </div>
    );
}