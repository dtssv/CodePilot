/**
 * One-shot bridge installation for App shell (auth, session, chat, context, MCP, needs_input).
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { onPluginEvent } from '../bridge';
import type { BudgetBreakdown } from '../components/ContextBudgetBar';
import type { ContextChipData } from '../components/ContextChip';
import type { SessionCostInfo } from '../components/SessionCostPanel';
import type { ChatMessage } from './chatTypes';
import { installAppSettingsBridge } from './appSettingsBridge';
import { installIdeThemeBridge } from './appShellBridge';
import { installChatV2Bridge } from './chatStore';
import { installContextBridge, requestContextEstimate } from './contextBridge';
import { installLegacyChatBridge } from './legacyChatBridge';
import { installMcpConfirmBridge } from './mcpConfirm';
import { bootstrapAuthenticatedSession, installModelAuthBridge, type ModelOption } from './modelAuthBridge';
import { clearMcpActivity, installMcpActivityBridge } from './mcpActivityStore';
import { installNeedsInputBridge } from './needsInputStore';
import { installRateLimitBridge } from './rateLimitStore';
import { installMessageQueueBridge } from './messageQueueStore';
import { installShellAskBridge } from './shellAskStore';
import { installPendingBridge } from './pending';
import { installSessionBridge } from './sessionBridge';

export interface AppBootstrapRefs {
    activeReplyRef: MutableRefObject<boolean>;
    activeTurnIdRef: MutableRefObject<string>;
    selectedModelIdRef: MutableRefObject<string>;
}

export interface AppBootstrapSetters {
    setAuthenticated: (v: boolean) => void;
    setModels: Dispatch<SetStateAction<ModelOption[]>>;
    setSelectedModelId: Dispatch<SetStateAction<string>>;
    setLastRoute: Dispatch<SetStateAction<{ name?: string; tier?: string; reason?: string } | null>>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setContextChips: Dispatch<SetStateAction<ContextChipData[]>>;
    setAbnormalTermination: Dispatch<SetStateAction<boolean>>;
    setHasCheckpoint: Dispatch<SetStateAction<boolean>>;
    setRecoveryMode: Dispatch<SetStateAction<'exact' | 'soft' | 'none'>>;
    setIsResuming: Dispatch<SetStateAction<boolean>>;
    setContextTokens: Dispatch<SetStateAction<number>>;
    setTotalTokens: Dispatch<SetStateAction<number>>;
    setEstimatedTokens: Dispatch<SetStateAction<number>>;
    setBudgetBreakdown: Dispatch<SetStateAction<BudgetBreakdown | null>>;
    setTheme: Dispatch<SetStateAction<'dark' | 'light' | 'high-contrast'>>;
    setSessionCost: Dispatch<SetStateAction<SessionCostInfo>>;
    setAutoApply: Dispatch<SetStateAction<boolean>>;
    setSendError: Dispatch<SetStateAction<string | null>>;
}

export function installCoreBridges(refs: AppBootstrapRefs, setters: AppBootstrapSetters): () => void {
    installChatV2Bridge();
    const offMessageQueue = installMessageQueueBridge();
    const offShellAsk = installShellAskBridge();
    installPendingBridge();
    installMcpConfirmBridge();
    const offNeedsInput = installNeedsInputBridge();
    const offRateLimit = installRateLimitBridge();
    const offMcpActivity = installMcpActivityBridge();
    const offAuth = installModelAuthBridge({
        setAuthenticated: setters.setAuthenticated,
        setModels: setters.setModels,
        setSelectedModelId: setters.setSelectedModelId,
        setLastRoute: setters.setLastRoute,
        getSelectedModelId: () => refs.selectedModelIdRef.current,
    });
    return () => {
        offMessageQueue();
        offShellAsk();
        offNeedsInput();
        offRateLimit();
        offMcpActivity();
        offAuth();
    };
}

export function installSessionEffects(setters: AppBootstrapSetters, refs: AppBootstrapRefs): () => void {
    return installSessionBridge({
        onSessionSwitched: () => {
            setters.setMessages([]);
            setters.setContextChips([]);
            setters.setAbnormalTermination(false);
            setters.setHasCheckpoint(false);
            setters.setRecoveryMode('none');
            refs.activeReplyRef.current = false;
            refs.activeTurnIdRef.current = '';
            clearMcpActivity();
        },
        onSessionMessages: (data) => {
            setters.setMessages(data.messages as ChatMessage[]);
            setters.setAbnormalTermination(data.abnormalTermination ?? false);
            setters.setHasCheckpoint(data.hasCheckpoint ?? false);
            const mode = data.recoveryMode;
            setters.setRecoveryMode(mode === 'exact' || mode === 'soft' ? mode : 'none');
        },
    });
}

export function installLegacyChatEffect(
    v2Enabled: boolean,
    refs: AppBootstrapRefs,
    setters: Pick<
        AppBootstrapSetters,
        'setMessages' | 'setAbnormalTermination' | 'setHasCheckpoint' | 'setRecoveryMode' | 'setIsResuming'
    >,
): () => void {
    return installLegacyChatBridge(
        v2Enabled,
        { activeReplyRef: refs.activeReplyRef, activeTurnIdRef: refs.activeTurnIdRef },
        {
            setMessages: setters.setMessages,
            setAbnormalTermination: setters.setAbnormalTermination,
            setHasCheckpoint: setters.setHasCheckpoint,
            setRecoveryMode: setters.setRecoveryMode,
            setIsResuming: setters.setIsResuming,
        },
    );
}

export function installContextEffects(setters: Pick<AppBootstrapSetters, 'setContextChips' | 'setContextTokens' | 'setTotalTokens' | 'setEstimatedTokens' | 'setBudgetBreakdown'>): () => void {
    return installContextBridge({
        setContextChips: setters.setContextChips,
        setContextTokens: setters.setContextTokens,
        setTotalTokens: setters.setTotalTokens,
        setEstimatedTokens: setters.setEstimatedTokens,
        setBudgetBreakdown: setters.setBudgetBreakdown,
    });
}

export function installContextEstimateDebounce(
    contextChips: ContextChipData[],
    setEstimatedTokens: Dispatch<SetStateAction<number>>,
): void | (() => void) {
    if (contextChips.length === 0) {
        setEstimatedTokens(0);
        return;
    }
    const timer = window.setTimeout(() => requestContextEstimate(contextChips), 250);
    return () => window.clearTimeout(timer);
}

export function installThemeBridge(setTheme: AppBootstrapSetters['setTheme']): () => void {
    return installIdeThemeBridge(setTheme);
}

export function installVisionErrorBridge(setSendError: AppBootstrapSetters['setSendError']): () => void {
    return onPluginEvent('error', (payload) => {
        const data = payload as { code?: number; message?: string };
        if (data.code === 40001 && data.message) setSendError(data.message);
        if (data.code === 42901 && data.message) setSendError(data.message);
    });
}

export function installAuthenticatedSettings(
    authenticated: boolean,
    refs: AppBootstrapRefs,
    setters: Pick<AppBootstrapSetters, 'setMessages' | 'setSessionCost' | 'setAutoApply'>,
): (() => void) | undefined {
    if (!authenticated) return undefined;
    bootstrapAuthenticatedSession();
    return installAppSettingsBridge({
        setMessages: setters.setMessages,
        setSessionCost: setters.setSessionCost,
        setAutoApply: setters.setAutoApply,
        isActiveReply: () => refs.activeReplyRef.current,
    });
}
