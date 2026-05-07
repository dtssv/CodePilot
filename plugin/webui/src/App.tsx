import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from './bridge';
import { ChatView } from './components/ChatView';
import { InputBar } from './components/InputBar';
import { PlanPanel } from './components/PlanPanel';

interface ModelOption {
    id: string;
    name: string;
    type: 'system' | 'custom';
}

export function App() {
    const [mode, setMode] = useState<'agent' | 'chat'>('agent');
    const [models, setModels] = useState<ModelOption[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');

    useEffect(() => {
        // Request model list from plugin host on mount
        sendToPlugin('fetch_models', {});

        const unsub = onPluginEvent('models_loaded', (payload) => {
            const data = payload as { system?: ModelOption[]; custom?: ModelOption[] };
            const all: ModelOption[] = [
                ...(data.system || []).map((m) => ({ ...m, type: 'system' as const })),
                ...(data.custom || []).map((m) => ({ ...m, type: 'custom' as const })),
            ];
            setModels(all);
            // Default to first system model if none selected
            if (!selectedModelId && all.length > 0) {
                setSelectedModelId(all[0].id);
            }
        });
        return unsub;
    }, []);

    const handleSend = (text: string) => {
        sendToPlugin('user_message', { text, mode, modelId: selectedModelId || undefined });
    };

    const handleStop = () => {
        sendToPlugin('stop', {});
    };

    return (
        <div className="app-layout">
            <header className="app-header">
                <span className="app-title">CodePilot</span>
                <select
                    className="model-select"
                    value={selectedModelId}
                    onChange={(e) => setSelectedModelId(e.target.value)}
                    title="Select model"
                >
                    {models.map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.name}{m.type === 'custom' ? ' (custom)' : ''}
                        </option>
                    ))}
                </select>
                <select
                    className="mode-select"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'agent' | 'chat')}
                >
                    <option value="agent">Agent</option>
                    <option value="chat">Chat</option>
                </select>
            </header>
            <div className="app-body">
                <div className="chat-area">
                    <ChatView />
                </div>
                {mode === 'agent' && (
                    <aside className="side-panel">
                        <PlanPanel />
                    </aside>
                )}
            </div>
            <InputBar onSend={handleSend} onStop={handleStop} />
        </div>
    );
}