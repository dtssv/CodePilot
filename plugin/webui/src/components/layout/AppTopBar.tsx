import { RefObject } from 'react';
import { SessionSidebarV2, type SessionInfoV2 } from '../sessions/SessionSidebarV2';

interface AppTopBarProps {
    historyOpen: boolean;
    historyBtnRef: RefObject<HTMLButtonElement>;
    sessions: SessionInfoV2[];
    activeSessionId: string;
    onToggleHistory: () => void;
    onNewChat: () => void;
    onSelectSession: (id: string) => void;
    onDeleteSession: (id: string) => void;
}

export function AppTopBar({
    historyOpen,
    historyBtnRef,
    sessions,
    activeSessionId,
    onToggleHistory,
    onNewChat,
    onSelectSession,
    onDeleteSession,
}: AppTopBarProps) {
    return (
        <>
            <div className="top-bar">
                <button
                    ref={historyBtnRef}
                    className="history-btn"
                    onClick={onToggleHistory}
                    title="Chat history"
                >
                    ☰ History
                </button>
                <button className="new-chat-btn-top" onClick={onNewChat} title="New chat">
                    + New Chat
                </button>
            </div>
            {historyOpen && (
                <div className="history-popup">
                    <SessionSidebarV2
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        onSelect={onSelectSession}
                        onNew={onNewChat}
                        onDelete={onDeleteSession}
                    />
                </div>
            )}
        </>
    );
}
