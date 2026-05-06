import { useState } from 'react';
import { sendToPlugin } from './bridge';
import { ChatView } from './components/ChatView';
import { InputBar } from './components/InputBar';
import { PlanPanel } from './components/PlanPanel';

export function App() {
    const [mode, setMode] = useState<'agent' | 'chat'>('agent');

    const handleSend = (text: string) => {
        sendToPlugin('user_message', { text, mode });
    };

    const handleStop = () => {
        sendToPlugin('stop', {});
    };

    return (
        <div className="app-layout">
            <header className="app-header">
                <span className="app-title">CodePilot</span>
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