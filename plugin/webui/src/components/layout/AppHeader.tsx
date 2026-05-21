import { RefObject } from 'react';
import type { AppTab } from '../../types/appTabs';
import { useTranslation } from '../../i18n';
import { SessionSidebarV2, type SessionInfoV2 } from '../sessions/SessionSidebarV2';
import { AppShellNav } from './AppShellNav';
import { LanguageSelector } from './LanguageSelector';

export interface AppHeaderProps {
    activeTab: AppTab;
    theme: 'dark' | 'light' | 'high-contrast';
    pendingMemoryCount: number;
    bgActiveCount: number;
    historyOpen: boolean;
    historyBtnRef: RefObject<HTMLButtonElement>;
    sessions: SessionInfoV2[];
    activeSessionId: string;
    onTabChange: (tab: AppTab) => void;
    onThemeCycle: () => void;
    onToggleHistory: () => void;
    onNewChat: () => void;
    onSelectSession: (id: string) => void;
    onDeleteSession: (id: string) => void;
}

/** Session controls + unified section navigation (replaces bottom tab bar). */
export function AppHeader({
    activeTab,
    theme,
    pendingMemoryCount,
    bgActiveCount,
    historyOpen,
    historyBtnRef,
    sessions,
    activeSessionId,
    onTabChange,
    onThemeCycle,
    onToggleHistory,
    onNewChat,
    onSelectSession,
    onDeleteSession,
}: AppHeaderProps) {
    const { t } = useTranslation();

    return (
        <header className="app-header">
            <div className="app-header-session">
                <button
                    ref={historyBtnRef}
                    type="button"
                    className="history-btn"
                    onClick={onToggleHistory}
                    title={t('header.history')}
                >
                    ☰ {t('header.history')}
                </button>
                <button type="button" className="new-chat-btn-top" onClick={onNewChat} title={t('header.newChat')}>
                    + {t('header.newChat')}
                </button>
                <LanguageSelector />
            </div>
            <AppShellNav
                activeTab={activeTab}
                theme={theme}
                pendingMemoryCount={pendingMemoryCount}
                bgActiveCount={bgActiveCount}
                onTabChange={onTabChange}
                onThemeCycle={onThemeCycle}
            />
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
        </header>
    );
}
