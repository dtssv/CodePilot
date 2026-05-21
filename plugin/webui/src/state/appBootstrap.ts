/**
 * One-shot bridge installation for App shell (auth, session, chat, context, MCP, needs_input).
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { onPluginEvent } from '../bridge';
import type { BudgetBreakdown } from '../components/ContextBudgetBar';
import type { ContextChipData } from '../components/ContextChip';
import type { SessionCostInfo } from '../components/SessionCostPanel';
import { clearActiveSkills, installActiveSkillsBridge } from './activeSkillsStore';
import { setAdmissionWaitState } from './admissionWaitStore';
import { installAppSettingsBridge } from './appSettingsBridge';
import { installIdeThemeBridge } from './appShellBridge';
import { installChatV2Bridge } from './chatStore';
import type { ChatMessage } from './chatTypes';
import { installCodebaseBridge } from './codebase';
import { installContextBridge, requestContextEstimate } from './contextBridge';
import { installLegacyChatBridge } from './legacyChatBridge';
import { installLocaleBridge } from './localeBridge';
import { clearMcpActivity, installMcpActivityBridge } from './mcpActivityStore';
import { installMcpConfirmBridge } from './mcpConfirm';
import { installMcpHooksBridge } from './mcpHooks';
import { installMessageQueueBridge } from './messageQueueStore';
import { bootstrapAuthenticatedSession, installModelAuthBridge, type ModelOption } from './modelAuthBridge';
import { installNeedsInputBridge } from './needsInputStore';
import { installPendingBridge } from './pending';
import { installRateLimitBridge } from './rateLimitStore';
import { installRulesMemoryBridge } from './rulesMemory';
import { installSessionBridge } from './sessionBridge';
import { installShellAskBridge } from './shellAskStore';
import { installShellPolicyBridge } from './shellPolicy';

export interface AppBootstrapRefs {
    activeReplyRef: MutableRefObject<boolean>;
    activeTurnIdRef: MutableRefObject<string>;
    selectedModelIdRef: MutableRefObject<string>;
}

export interface AppBootstrapSetters {
    setAuthChecked: (v: boolean) => void;
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

/** Register panel event bridges once at startup so tabs work before first visit. */
export function installPanelBridges(): void {
    installMcpHooksBridge();
    installCodebaseBridge();
    installRulesMemoryBridge();
    installShellPolicyBridge();
}

export function installCoreBridges(refs: AppBootstrapRefs, setters: AppBootstrapSetters): () => void {
    installChatV2Bridge();
    const offMessageQueue = installMessageQueueBridge();
    const offShellAsk = installShellAskBridge();
    installPendingBridge();
    installMcpConfirmBridge();
    const offNeedsInput = installNeedsInputBridge();
    const offRateLimit = installRateLimitBridge();
    const offAdmission = installAdmissionBridge();
    const offMcpActivity = installMcpActivityBridge();
    const offActiveSkills = installActiveSkillsBridge();
    const offLocale = installLocaleBridge();
    const offAuth = installModelAuthBridge({
        setAuthChecked: setters.setAuthChecked,
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
        offAdmission();
        offMcpActivity();
        offActiveSkills();
        offLocale();
        offAuth();
    };
}

/** Bridge for admission queue events (admission_queued, admission_retry_ask, admission_granted). */
function installAdmissionBridge(): () => void {
    const offQueued = onPluginEvent('admission_queued', (payload) => {
        const p = payload as Record<string, unknown>;
        setAdmissionWaitState({
            message: String(p.message ?? ''),
            attempt: Number(p.attempt ?? 1),
            maxAttempts: Number(p.maxAttempts ?? 3),
            retryAfterSec: Number(p.retryAfterSec ?? 30),
            userQueued: Number(p.userQueued ?? 0),
            userRunning: Number(p.userRunning ?? 0),
            globalQueued: Number(p.globalQueued ?? 0),
            globalRunning: Number(p.globalRunning ?? 0),
            askRetry: false,
        });
    });
    const offAsk = onPluginEvent('admission_retry_ask', (payload) => {
        const p = payload as Record<string, unknown>;
        setAdmissionWaitState({
            message: String(p.message ?? '是否继续重试？'),
            attempt: Number(p.attempt ?? 3),
            maxAttempts: Number(p.maxAttempts ?? 3),
            retryAfterSec: 0,
            askRetry: true,
        });
    });
    const offGranted = onPluginEvent('admission_granted', () => {
        setAdmissionWaitState(null);
    });
    // Also handle legacy server_backoff — clear admission state
    const offBackoff = onPluginEvent('server_backoff', () => {
        // Keep existing behavior — just show a generic backoff state
        setAdmissionWaitState({
            message: '服务端繁忙，正在等待…',
            attempt: 0,
            maxAttempts: 3,
            retryAfterSec: 30,
            askRetry: false,
        });
    });
    return () => {
        offQueued();
        offAsk();
        offGranted();
        offBackoff();
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
            clearActiveSkills();
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
