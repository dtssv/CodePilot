/**
 * Session / branch plugin events → sessionUiStore + App callbacks.
 */

import { onPluginEvent, sendToPlugin } from '../bridge';
import type { SessionInfoV2 } from '../components/sessions/SessionSidebarV2';
import type { LegacyHydrateMessage } from './chatHydrate';
import {
    hasRunningTurn,
    hydrateChatV2FromEnvelopes,
    hydrateChatV2FromLegacyMessages,
    isV2Enabled,
    resetChatV2,
    setChatV2LastSeq,
} from './chatStore';
import type { ToolExecutionState } from './chatTypes';
import type { EventEnvelope } from './events';
import {
    completeFreshChat,
    getActiveSessionId,
    isPendingNewChat,
    markPendingNewChat,
    setActiveSessionId,
    setBranchList,
    setSessionList,
    type BranchInfo,
} from './sessionUiStore';

export interface SessionMessagesPayload {
    sessionId?: string;
    messages: LegacyHydrateMessage[];
    /** Persisted v2 envelopes for chronological replay (preferred over legacy hydrate). */
    envelopes?: EventEnvelope[];
    freshChat?: boolean;
    /** Plugin EventBus seq — prevents replay_since from duplicating turns after hydrate. */
    envelopeSeq?: number;
    abnormalTermination?: boolean;
    hasCheckpoint?: boolean;
    hasContinuationToken?: boolean;
    recoveryMode?: 'exact' | 'soft' | 'none';
}

export interface SessionBridgeHandlers {
    onSessionMessages: (data: SessionMessagesPayload) => void;
    onSessionSwitched: (sessionId: string) => void;
}

function normalizeToolCall(tc: NonNullable<LegacyHydrateMessage['toolCalls']>[number]) {
    const result = tc.result;
    const executionState = (tc.executionState as ToolExecutionState | undefined)
        ?? (result ? terminalStatusFromResult(tc.status, result) : undefined);
    let status = tc.status || 'success';
    if (status === 'running' && (result || executionState)) {
        status = executionState === 'error' ? 'error' : 'success';
    }
    return {
        id: tc.id || '',
        name: tc.name || 'unknown',
        args: tc.args || {},
        status,
        result,
        executionState,
        startedAt: tc.startedAt,
        resultAt: tc.resultAt,
    };
}

function terminalStatusFromResult(
    status: string | undefined,
    result: Record<string, unknown>,
): ToolExecutionState {
    const stderr = String(result.stderr ?? '');
    if (stderr.includes('用户已跳过') || stderr.includes('Skipped by user')) {
        return 'skipped';
    }
    if (stderr.includes('用户已拒绝') || stderr.includes('Denied:')) {
        return 'denied';
    }
    return status === 'error' ? 'error' : 'success';
}

function normalizeMessages(messages: LegacyHydrateMessage[]): LegacyHydrateMessage[] {
    return messages.map((msg) => ({
        ...msg,
        turnId: msg.turnId,
        planSteps: msg.planSteps,
        agentSteps: msg.agentSteps,
        images: msg.images?.map((img) => ({
            url: img.url,
            mimeType: img.mimeType,
            name: img.name,
            description: img.description,
        })),
        toolCalls: msg.toolCalls?.map((tc) => normalizeToolCall(tc)),
    }));
}

/** Wire session_list / session_switched / branch_list / session_messages. Idempotent per mount. */
export function installSessionBridge(handlers: SessionBridgeHandlers): () => void {
    const unsubs = [
        onPluginEvent('session_list', (payload) => {
            const data = payload as { sessions: SessionInfoV2[]; activeSessionId: string };
            setSessionList(data.sessions, data.activeSessionId ?? '');
        }),
        onPluginEvent('session_switched', (payload) => {
            const data = payload as { id: string; promote?: boolean };
            const nextId = data.id ?? '';
            const prevId = getActiveSessionId();
            setActiveSessionId(nextId, { promote: data.promote });
            // Promote '' → new session id after first message: keep live v2 turn, do not wipe UI.
            // chat_reset / freshChat already reset v2; only clear when switching between two real sessions.
            const switchingSession =
                prevId !== '' && nextId !== '' && prevId !== nextId && !data.promote;
            if (switchingSession) {
                resetChatV2(undefined, { suppressEnvelopes: false });
            }
            if (nextId !== prevId || data.promote) {
                handlers.onSessionSwitched(nextId);
            }
            if (data.promote && nextId) {
                completeFreshChat();
            }
            if (nextId && !data.promote) {
                sendToPlugin('branch.tree', { sessionId: nextId }).catch(() => undefined);
            } else if (nextId && data.promote) {
                sendToPlugin('branch.tree', { sessionId: nextId }).catch(() => undefined);
            }
        }),
        onPluginEvent('chat_reset', (payload) => {
            const data = payload as { replayBaseline?: number };
            markPendingNewChat();
            resetChatV2(data.replayBaseline, { suppressEnvelopes: true });
            handlers.onSessionSwitched('');
        }),
        onPluginEvent('branch_list', (payload) => {
            const data = payload as { branches: BranchInfo[]; activeBranchId: string };
            setBranchList(data.branches, data.activeBranchId);
        }),
        onPluginEvent('branch.tree.result', (payload) => {
            const data = payload as { branches: BranchInfo[] };
            const active = data.branches.find((b) => b.active)?.branchId ?? 'main';
            setBranchList(data.branches, active);
        }),
        onPluginEvent('session_messages', (payload) => {
            const data = payload as SessionMessagesPayload & { freshChat?: boolean };
            if (data.freshChat) {
                markPendingNewChat();
                handlers.onSessionMessages({ messages: [], freshChat: true });
                return;
            }
            const active = getActiveSessionId();
            if (data.sessionId != null && data.sessionId !== active) {
                return;
            }
            // Ignore stale hydration with old messages while user is in a fresh chat
            if (isPendingNewChat() && (data.messages?.length ?? 0) > 0) {
                return;
            }
            if (!active && data.sessionId && (data.messages?.length ?? 0) > 0) {
                return;
            }
            if (isV2Enabled() && hasRunningTurn()) {
                return;
            }
            const restored = normalizeMessages(data.messages ?? []);
            if (isV2Enabled()) {
                const rawEnvelopes = (data as { envelopes?: EventEnvelope[] }).envelopes;
                if (rawEnvelopes && rawEnvelopes.length > 0) {
                    hydrateChatV2FromEnvelopes(rawEnvelopes);
                } else {
                    hydrateChatV2FromLegacyMessages(restored);
                }
                if (typeof data.envelopeSeq === 'number') {
                    setChatV2LastSeq(data.envelopeSeq);
                }
                // v2 enabled: skip legacy setMessages to avoid unnecessary App rerender.
                // v2 store already has the data via hydrateChatV2From* above.
                // Only pass metadata (abnormalTermination, hasCheckpoint, recoveryMode).
                handlers.onSessionMessages({
                    messages: [],
                    abnormalTermination: data.abnormalTermination,
                    hasCheckpoint: data.hasCheckpoint,
                    envelopeSeq: data.envelopeSeq,
                });
            } else {
                handlers.onSessionMessages({
                    messages: restored,
                    abnormalTermination: data.abnormalTermination,
                    hasCheckpoint: data.hasCheckpoint,
                    envelopeSeq: data.envelopeSeq,
                });
            }
        }),
    ];
    return () => unsubs.forEach((u) => u());
}
