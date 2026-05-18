/**
 * Session / branch plugin events → sessionUiStore + App callbacks.
 */

import { onPluginEvent, sendToPlugin } from '../bridge';
import type { SessionInfoV2 } from '../components/sessions/SessionSidebarV2';
import { hydrateChatV2FromLegacyMessages, isV2Enabled, resetChatV2 } from './chatStore';
import type { LegacyHydrateMessage } from './chatHydrate';
import {
    getActiveSessionId,
    setActiveSessionId,
    setBranchList,
    setSessionList,
    type BranchInfo,
} from './sessionUiStore';

export interface SessionMessagesPayload {
    sessionId?: string;
    messages: LegacyHydrateMessage[];
    abnormalTermination?: boolean;
    hasCheckpoint?: boolean;
    hasContinuationToken?: boolean;
    recoveryMode?: 'exact' | 'soft' | 'none';
}

export interface SessionBridgeHandlers {
    onSessionMessages: (data: SessionMessagesPayload) => void;
    onSessionSwitched: (sessionId: string) => void;
}

function normalizeMessages(messages: LegacyHydrateMessage[]): LegacyHydrateMessage[] {
    return messages.map((msg) => ({
        ...msg,
        images: msg.images?.map((img) => ({
            url: img.url,
            mimeType: img.mimeType,
            name: img.name,
            description: img.description,
        })),
        toolCalls: msg.toolCalls?.map((tc) => ({
            id: tc.id || '',
            name: tc.name || 'unknown',
            args: tc.args || {},
            status: tc.status || 'success',
        })),
    }));
}

/** Wire session_list / session_switched / branch_list / session_messages. Idempotent per mount. */
export function installSessionBridge(handlers: SessionBridgeHandlers): () => void {
    const unsubs = [
        onPluginEvent('session_list', (payload) => {
            const data = payload as { sessions: SessionInfoV2[]; activeSessionId: string };
            setSessionList(data.sessions, data.activeSessionId);
        }),
        onPluginEvent('session_switched', (payload) => {
            const data = payload as { id: string };
            setActiveSessionId(data.id);
            resetChatV2();
            handlers.onSessionSwitched(data.id);
            if (data.id) {
                sendToPlugin('branch.tree', { sessionId: data.id }).catch(() => undefined);
            }
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
            const data = payload as SessionMessagesPayload;
            const active = getActiveSessionId();
            if (data.sessionId != null && data.sessionId !== active) {
                return;
            }
            const restored = normalizeMessages(data.messages ?? []);
            if (isV2Enabled()) {
                hydrateChatV2FromLegacyMessages(restored);
            }
            handlers.onSessionMessages({
                messages: restored,
                abnormalTermination: data.abnormalTermination,
                hasCheckpoint: data.hasCheckpoint,
            });
        }),
    ];
    return () => unsubs.forEach((u) => u());
}
