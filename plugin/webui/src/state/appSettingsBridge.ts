/**
 * Session cost, auto-apply, patch, console log events.
 */

import type { Dispatch, SetStateAction } from 'react';
import { onPluginEvent } from '../bridge';
import type { ConsoleEntry } from '../components/ConsolePanel';
import { logConsole } from './consoleStore';
import type { ChatMessage } from './chatTypes';
import type { SessionCostInfo } from '../components/SessionCostPanel';

export interface AppSettingsBridgeHandlers {
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setSessionCost: (c: SessionCostInfo) => void;
    setAutoApply: (v: boolean) => void;
    isActiveReply: () => boolean;
}

export function installAppSettingsBridge(h: AppSettingsBridgeHandlers): () => void {
    const unsubs = [
        onPluginEvent('patch', (p) => {
            const patchData = p as { files: unknown; hunks: unknown };
            if (h.isActiveReply()) return;
            h.setMessages((msgs) => [
                ...msgs,
                { role: 'system', content: 'Patch generated', diff: { path: '', hunks: JSON.stringify(patchData) } },
            ]);
        }),
        onPluginEvent('session_cost', (p) => {
            h.setSessionCost(p as SessionCostInfo);
        }),
        onPluginEvent('auto_apply_state', (payload) => {
            const data = payload as { enabled: boolean };
            h.setAutoApply(data.enabled);
        }),
        onPluginEvent('console_log', (payload) => {
            const data = payload as { type?: string; source?: string; data?: unknown };
            logConsole(
                (data.type as ConsoleEntry['type']) || 'info',
                data.source || 'plugin',
                data.data,
            );
        }),
    ];
    return () => unsubs.forEach((u) => u());
}
