import { sendToPlugin } from '../../bridge';
import type { ChatMessage } from '../../state/chatTypes';
import type { AppTab } from '../../types/appTabs';
import { BackgroundTasksPanel } from '../background/BackgroundTasksPanel';
import { ChatView } from '../ChatView';
import { CodebasePanel } from '../codebase/CodebasePanel';
import { ComposerPanel } from '../ComposerPanel';
import { ConsolePanel } from '../ConsolePanel';
import { ExportPanel } from '../export/ExportPanel';
import { InlineEditTimeline } from '../inline/InlineEditTimeline';
import { TabSettingsPanel } from '../inline/TabSettingsPanel';
import { IntegrationsPanel } from '../integrations/IntegrationsPanel';
import { MultiFileDiffPanel } from '../MultiFileDiffPanel';
import { NotepadsPanel } from '../NotepadsPanel';
import { RulesMemoryPanel } from '../rules/RulesMemoryPanel';
import { ShellPolicyPanel } from '../shell/ShellPolicyPanel';
import { TemplatesPanel } from '../templates/TemplatesPanel';
import { ChatViewV2 } from '../tools/v2/ChatViewV2';
import { UsagePanel } from '../usage/UsagePanel';
import { useTranslation } from '../../i18n';
import type { ConsoleEntry } from '../ConsolePanel';

export interface ChatMainAreaProps {
    activeTab: AppTab;
    activeSessionId: string;
    v2Enabled: boolean;
    messages: ChatMessage[];
    consoleEntries: ConsoleEntry[];
    abnormalTermination: boolean;
    recoveryMode: 'exact' | 'soft' | 'none';
    isResuming: boolean;
    sendError: string | null;
    onDismissSendError: () => void;
    onResumeSession: () => void;
    onDismissAbnormal: () => void;
    onClearConsole: () => void;
}

export function ChatMainArea({
    activeTab,
    activeSessionId,
    v2Enabled,
    messages,
    consoleEntries,
    abnormalTermination,
    recoveryMode,
    isResuming,
    sendError,
    onDismissSendError,
    onResumeSession,
    onDismissAbnormal,
    onClearConsole,
}: ChatMainAreaProps) {
    const { t } = useTranslation();

    return (
        <div className="chat-area">
            {activeTab === 'chat' && abnormalTermination && !isResuming && recoveryMode !== 'none' && (
                <div className="session-recovery-banner">
                    <div className="recovery-banner-content">
                        <span className="recovery-icon">⚠️</span>
                        <span className="recovery-text">
                            {recoveryMode === 'exact'
                                ? t('chat.recoveryExact')
                                : t('chat.recoverySoft')}
                        </span>
                        <button type="button" className="recovery-btn" onClick={onResumeSession}>
                            {recoveryMode === 'exact' ? t('chat.resumeExact') : t('chat.resumeSoft')}
                        </button>
                        <button type="button" className="recovery-dismiss-btn" onClick={onDismissAbnormal}>
                            {t('chat.dismissRecovery')}
                        </button>
                    </div>
                </div>
            )}
            {activeTab === 'chat' && isResuming && (
                <div className="session-resuming-banner">
                    <span className="resuming-spinner" />
                    <span className="resuming-text">{t('chat.resuming')}</span>
                </div>
            )}
            {activeTab === 'chat' && sendError && (
                <div className="send-error-banner" role="alert">
                    <span>{sendError}</span>
                    <button type="button" onClick={onDismissSendError} aria-label="Dismiss">×</button>
                </div>
            )}
            {activeTab === 'chat' && (
                <>
                    <InlineEditTimeline />
                    {v2Enabled ? (
                        <ChatViewV2 />
                    ) : (
                        <ChatView
                            messages={messages}
                            onForkFromMessage={(idx) => sendToPlugin('fork_from_message', { messageIndex: idx })}
                        />
                    )}
                </>
            )}
            {activeTab === 'composer' && <ComposerPanel />}
            {activeTab === 'integrations' && <IntegrationsPanel />}
            {activeTab === 'notepads' && <NotepadsPanel />}
            {activeTab === 'codebase' && <CodebasePanel />}
            {activeTab === 'rules' && <RulesMemoryPanel />}
            {activeTab === 'shell' && <ShellPolicyPanel />}
            {activeTab === 'tab' && <TabSettingsPanel />}
            {activeTab === 'usage' && <UsagePanel />}
            {activeTab === 'templates' && <TemplatesPanel />}
            {activeTab === 'background' && <BackgroundTasksPanel />}
            {activeTab === 'export' && <ExportPanel sessionId={activeSessionId} />}
            {activeTab === 'console' && <ConsolePanel entries={consoleEntries} onClear={onClearConsole} />}
            <MultiFileDiffPanel />
        </div>
    );
}
