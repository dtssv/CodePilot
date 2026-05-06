import { useCallback, useRef, useState } from 'react';

interface InputBarProps {
    onSend: (text: string) => void;
    onStop: () => void;
}

export function InputBar({ onSend, onStop }: InputBarProps) {
    const [text, setText] = useState('');
    const [running, setRunning] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

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
                placeholder="Ask CodePilot..."
                rows={3}
            />
            <div className="input-actions">
                {running ? (
                    <button className="stop-btn" onClick={handleStop}>Stop</button>
                ) : (
                    <button className="primary send-btn" onClick={handleSubmit} disabled={!text.trim()}>
                        Send
                    </button>
                )}
            </div>
        </div>
    );
}