import { useCallback, useEffect, useRef, useState } from 'react';
import { onPluginEvent } from '../bridge';

interface InputBarProps {
    onSend: (text: string) => void;
    onStop: () => void;
}

export function InputBar({ onSend, onStop }: InputBarProps) {
    const [text, setText] = useState('');
    const [running, setRunning] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const unsub = onPluginEvent('done', () => setRunning(false));
        return unsub;
    }, []);

    const handleSubmit = useCallback(() => {
        const trimmed = text.trim();
        if (!trimmed) return;
        onSend(trimmed);
        setText('');
        setRunning(true);
    }, [text, onSend]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleStop = () => {
        onStop();
        setRunning(false);
    };

    return (
        <div className="input-bar">
            <textarea
                ref={textareaRef}
                className="input-textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask CodePilot... (Enter to send, Shift+Enter for newline)"
                rows={2}
            />
            <div className="input-send-area">
                {running ? (
                    <button className="stop-btn" onClick={handleStop}>Stop</button>
                ) : (
                    <button className="send-btn" onClick={handleSubmit} disabled={!text.trim()}>↑</button>
                )}
            </div>
        </div>
    );
}