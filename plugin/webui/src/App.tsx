import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from './bridge';
import { ChatView } from './components/ChatView';
import { InputBar } from './components/InputBar';
import { SessionSidebar, SessionInfo } from './components/SessionSidebar';

interface ModelOption {
    id: string;
    name: string;
    type: 'system' | 'custom';
}

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCall?: { id: string; name: string; args: unknown };
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: { question: string; options: string[] };
    diff?: { path: string; hunks: string };
    _streaming?: boolean;
}

export function App() {
    const [mode, setMode] = useState<'agent' | 'chat'>('agent');
    const [models, setModels] = useState<ModelOption[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string>('');
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [sidebarOpen, setSidebarOpen] = useState(true);

    useEffect(() => {
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
            // Session switched — reset messages
            onPluginEvent('session_switched', (payload) => {
                const data = payload as { id: string };
                setActiveSessionId(data.id);
                setMessages([]);
            }),
            // Restore messages from local store
            onPluginEvent('session_messages', (payload) => {
                const data = payload as { messages: ChatMessage[] };
                setMessages(data.messages);
            }),
            // User message saved from plugin (after persistence)
            onPluginEvent('user_message_saved', (payload) => {
                const msg = payload as { role: string; content: string };
                setMessages((prev) => [...prev, { role: 'user' as const, content: msg.content }]);
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
        ];
        return () => unsubs.forEach((u) => u());
    }, []);

    const handleSend = (text: string) => {
        sendToPlugin('user_message', { text, mode, modelId: selectedModelId || undefined });
    };

    const handleStop = () => {
        sendToPlugin('stop', {});
    };

    const handleNewSession = () => {
        sendToPlugin('new_session', {});
    };

    const handleSelectSession = (id: string) => {
        if (id !== activeSessionId) {
            sendToPlugin('switch_session', { sessionId: id });
        }
    };

    const handleDeleteSession = (id: string) => {
        sendToPlugin('delete_session', { sessionId: id });
    };

    return (
        <div className="app-layout">
            {sidebarOpen && (
                <SessionSidebar
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    onSelect={handleSelectSession}
                    onNew={handleNewSession}
                    onDelete={handleDeleteSession}
                />
            )}
            <div className="main-area">
                <div className="chat-area">
                    <ChatView messages={messages} />
                </div>
                <div className="input-section">
                    <InputBar onSend={handleSend} onStop={handleStop} />
                    <div className="input-options">
                        <button
                            className="sidebar-toggle"
                            onClick={() => setSidebarOpen(!sidebarOpen)}
                            title="Toggle sidebar"
                        >
                            {sidebarOpen ? '◀' : '▶'}
                        </button>
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
                </div>
            </div>
        </div>
    );
}