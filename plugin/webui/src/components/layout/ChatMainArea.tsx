import { sendToPlugin } from '../../bridge';
import type { ChatMessage } from '../../state/chatTypes';
import type { AppTab } from '../../types/appTabs';
import { ChangePanel } from '../apply/ChangePanel';
import { BackgroundTasksPanel } from '../background/BackgroundTasksPanel';
import { ChatView } from '../ChatView';
import { CodebasePanel } from '../codebase/CodebasePanel';
import { ComposerPanel } from '../ComposerPanel';
import { ConsolePanel } from '../ConsolePanel';
import { ExportPanel } from '../export/ExportPanel';
import { InlineEditTimeline } from '../inline/InlineEditTimeline';
import { TabSettingsPanel } from '../inline/TabSettingsPanel';
import { MarketplacePanel } from '../MarketplacePanel';
import { McpHooksPanel } from '../mcp/McpHooksPanel';
import { MultiFileDiffPanel } from '../MultiFileDiffPanel';
import { NotepadsPanel } from '../NotepadsPanel';
import { RulesMemoryPanel } from '../rules/RulesMemoryPanel';
import { ShellPolicyPanel } from '../shell/ShellPolicyPanel';
import { TemplatesPanel } from '../templates/TemplatesPanel';
import { ChatViewV2 } from '../tools/v2/ChatViewV2';
import { UsagePanel } from '../usage/UsagePanel';
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
    return (
        <div className="chat-area">
            {activeTab === 'chat' && abnormalTermination && !isResuming && recoveryMode !== 'none' && (
                <div className="session-recovery-banner">
                    <div className="recovery-banner-content">
                        <span className="recovery-icon">⚠️</span>
                        <span className="recovery-text">
                            {recoveryMode === 'exact'
                                ? '任务已中断，可从断点恢复'
                                : '任务已中断，将基于已保存的计划与进度尽力继续（部分步骤可能重做）'}
                        </span>
                        <button type="button" className="recovery-btn" onClick={onResumeSession}>
                            {recoveryMode === 'exact' ? '从断点恢复' : '尽力继续'}
                        </button>
                        <button type="button" className="recovery-dismiss-btn" onClick={onDismissAbnormal}>
                            忽略
                        </button>
                    </div>
                </div>
            )}
            {activeTab === 'chat' && isResuming && (
                <div className="session-resuming-banner">
                    <span className="resuming-spinner" />
                    <span className="resuming-text">正在恢复任务...</span>
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
                    <ChangePanel />
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
            {activeTab === 'marketplace' && <MarketplacePanel />}
            {activeTab === 'notepads' && <NotepadsPanel />}
            {activeTab === 'codebase' && <CodebasePanel />}
            {activeTab === 'rules' && <RulesMemoryPanel />}
            {activeTab === 'mcp' && <McpHooksPanel />}
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
