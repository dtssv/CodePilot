import { useEffect, useMemo, useRef, useState } from 'react';
import { onPluginEvent, sendToPlugin } from './bridge';
import type { BudgetBreakdown } from './components/ContextBudgetBar';
import type { ContextChipData } from './components/ContextChip';
import { AppTabBar } from './components/layout/AppTabBar';
import { AppTopBar } from './components/layout/AppTopBar';
import { ChatInputSection } from './components/layout/ChatInputSection';
import { ChatMainArea } from './components/layout/ChatMainArea';
import { MessageQueueBanner } from './components/layout/MessageQueueBanner';
import { LoginPage } from './components/LoginPage';
import { McpConfirmDialog } from './components/mcp/McpConfirmDialog';
import type { SessionCostInfo } from './components/SessionCostPanel';
import {
    installAuthenticatedSettings,
    installContextEffects,
    installContextEstimateDebounce,
    installCoreBridges,
    installLegacyChatEffect,
    installSessionEffects,
    installThemeBridge,
    installVisionErrorBridge,
} from './state/appBootstrap';
import { useDocumentTheme } from './state/appShellBridge';
import { useBackgroundActiveCount } from './state/bgTasksStore';
import { finalizeRunningTurns, isV2Enabled } from './state/chatStore';
import type { ChatMessage } from './state/chatTypes';
import { clearConsole, useConsoleEntries } from './state/consoleStore';
import type { ModelOption } from './state/modelAuthBridge';
import { usePendingMemoryCount } from './state/rulesMemory';
import { createSendHandlers, createSessionActions, handleRemoveContextChip } from './state/sendBridge';
import { useBranches, useSessions } from './state/sessionUiStore';
import type { AppTab } from './types/appTabs';
export type { ToolCallInfo } from './state/chatTypes';

export function App() {
    const [authenticated, setAuthenticated] = useState(false);
    const [mode, setMode] = useState<'agent' | 'chat'>('agent');
    const [activeTab, setActiveTab] = useState<AppTab>('chat');
    const [models, setModels] = useState<ModelOption[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string>('');
    const [lastRoute, setLastRoute] = useState<{ name?: string; tier?: string; reason?: string } | null>(null);
    const [maxMode, setMaxMode] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const { sessions, activeSessionId } = useSessions();
    const { branches, activeBranchId } = useBranches();
    const pendingMemoryCount = usePendingMemoryCount();
    const bgActiveCount = useBackgroundActiveCount();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [contextChips, setContextChips] = useState<ContextChipData[]>([]);
    const [contextTokens, setContextTokens] = useState(0);
    const [totalTokens, setTotalTokens] = useState(128000);
    const [estimatedTokens, setEstimatedTokens] = useState(0);
    const [budgetBreakdown, setBudgetBreakdown] = useState<BudgetBreakdown | null>(null);
    const [theme, setTheme] = useState<'dark' | 'light' | 'high-contrast'>('dark');
    const [sessionCost, setSessionCost] = useState<SessionCostInfo>({
        messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0,
    });
    const [abnormalTermination, setAbnormalTermination] = useState(false);
    const [, setHasCheckpoint] = useState(false);
    const [recoveryMode, setRecoveryMode] = useState<'exact' | 'soft' | 'none'>('none');
    const [isResuming, setIsResuming] = useState(false);
    const [autoApply, setAutoApply] = useState(false);
    const historyBtnRef = useRef<HTMLButtonElement>(null);
    const activeReplyRef = useRef(false);
    const activeTurnIdRef = useRef('');
    const selectedModelIdRef = useRef(selectedModelId);
    selectedModelIdRef.current = selectedModelId;
    const v2Enabled = isV2Enabled();
    const consoleEntries = useConsoleEntries();

    const bootstrapSetters = useMemo(
        () => ({
            setAuthenticated,
            setModels,
            setSelectedModelId,
            setLastRoute,
            setMessages,
            setContextChips,
            setAbnormalTermination,
            setHasCheckpoint,
            setRecoveryMode,
            setIsResuming,
            setContextTokens,
            setTotalTokens,
            setEstimatedTokens,
            setBudgetBreakdown,
            setTheme,
            setSessionCost,
            setAutoApply,
            setSendError,
        }),
        [],
    );

    const bootstrapRefs = useMemo(
        () => ({ activeReplyRef, activeTurnIdRef, selectedModelIdRef }),
        [],
    );

    useEffect(() => installCoreBridges(bootstrapRefs, bootstrapSetters), [bootstrapRefs, bootstrapSetters]);
    useEffect(() => installSessionEffects(bootstrapSetters, bootstrapRefs), [bootstrapSetters, bootstrapRefs]);
    useEffect(
        () => installLegacyChatEffect(v2Enabled, bootstrapRefs, bootstrapSetters),
        [v2Enabled, bootstrapRefs, bootstrapSetters],
    );
    useEffect(() => installContextEffects(bootstrapSetters), [bootstrapSetters]);
    useEffect(() => installContextEstimateDebounce(contextChips, setEstimatedTokens), [contextChips]);
    useDocumentTheme(theme);
    useEffect(() => installThemeBridge(setTheme), []);
    useEffect(() => installVisionErrorBridge(setSendError), []);
    useEffect(() => {
        const offQueued = onPluginEvent('message_queued', (payload) => {
            const size = (payload as { queueSize?: number }).queueSize ?? 1;
            setSendError(`上一条任务仍在执行，消息已加入队列（${size}）`);
        });
        const offRunning = onPluginEvent('conversation_running', (payload) => {
            const running = Boolean((payload as { running?: boolean }).running);
            if (!running) {
                setSendError(null);
                finalizeRunningTurns();
            }
        });
        return () => {
            offQueued();
            offRunning();
        };
    }, []);
    useEffect(
        () => installAuthenticatedSettings(authenticated, bootstrapRefs, bootstrapSetters),
        [authenticated, bootstrapRefs, bootstrapSetters],
    );

    const { handleSend, handleStop, clearSessionLocalState } = useMemo(
        () =>
            createSendHandlers({
                v2Enabled,
                mode,
                messages,
                selectedModelId,
                models,
                maxMode,
                activeReplyRef,
                activeTurnIdRef,
                setMessages,
                setContextChips,
                onSendBlocked: setSendError,
            }),
        [v2Enabled, mode, messages, selectedModelId, models, maxMode],
    );

    const sessionActions = useMemo(
        () => createSessionActions(clearSessionLocalState),
        [clearSessionLocalState],
    );

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

    if (!authenticated) {
        return <LoginPage />;
    }

    return (
        <>
            <McpConfirmDialog />
            <div className="app-layout">
                <div className="main-area">
                    <AppTopBar
                        historyOpen={historyOpen}
                        historyBtnRef={historyBtnRef}
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        onToggleHistory={() => setHistoryOpen((o) => !o)}
                        onNewChat={() =>
                            sessionActions.handleNewSession(
                                setHistoryOpen,
                                setAbnormalTermination,
                                setHasCheckpoint,
                                setRecoveryMode,
                                setIsResuming,
                            )
                        }
                        onSelectSession={(id) => sessionActions.handleSelectSession(id, activeSessionId, setHistoryOpen)}
                        onDeleteSession={sessionActions.handleDeleteSession}
                    />
                    <ChatMainArea
                        activeTab={activeTab}
                        activeSessionId={activeSessionId}
                        v2Enabled={v2Enabled}
                        messages={messages}
                        consoleEntries={consoleEntries}
                        abnormalTermination={abnormalTermination}
                        recoveryMode={recoveryMode}
                        isResuming={isResuming}
                        sendError={sendError}
                        onDismissSendError={() => setSendError(null)}
                        onResumeSession={() => {
                            setIsResuming(true);
                            sendToPlugin('resume_session', {});
                        }}
                        onDismissAbnormal={() => setAbnormalTermination(false)}
                        onClearConsole={() => clearConsole()}
                    />
                    <div className="input-section">
                        {activeTab === 'chat' && <MessageQueueBanner />}
                        {activeTab === 'chat' && (
                            <ChatInputSection
                                contextTokens={contextTokens}
                                totalTokens={totalTokens}
                                estimatedTokens={estimatedTokens}
                                budgetBreakdown={budgetBreakdown}
                                sessionCost={sessionCost}
                                contextChips={contextChips}
                                mode={mode}
                                models={models}
                                selectedModelId={selectedModelId}
                                lastRoute={lastRoute}
                                maxMode={maxMode}
                                autoApply={autoApply}
                                branches={branches}
                                activeBranchId={activeBranchId}
                                onSend={handleSend}
                                onStop={handleStop}
                                onRemoveChip={(id) => handleRemoveContextChip(id, setContextChips)}
                                onPinContext={(chip) => setContextChips((prev) => [...prev, chip])}
                                onModelSelect={setSelectedModelId}
                                onModeChange={setMode}
                                onMaxModeChange={setMaxMode}
                                onAutoApplyChange={(enabled) => {
                                    setAutoApply(enabled);
                                    sendToPlugin('update_auto_apply', { enabled });
                                }}
                            />
                        )}
                        <AppTabBar
                            activeTab={activeTab}
                            theme={theme}
                            pendingMemoryCount={pendingMemoryCount}
                            bgActiveCount={bgActiveCount}
                            onTabChange={setActiveTab}
                            onThemeCycle={() => setTheme((t) => (t === 'dark' ? 'light' : t === 'light' ? 'high-contrast' : 'dark'))}
                        />
                    </div>
                </div>
            </div>
        </>
    );
}
