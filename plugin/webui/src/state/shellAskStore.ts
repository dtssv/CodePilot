/**
 * Pending shell.exec permission (plugin envelope shell.ask → WebUI inline actions).
 */

import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
import { hasRunningTurn, subscribeChatV2 } from './chatStore';
import type { EventEnvelope } from './events';

export type ShellGrantDecision = 'allow' | 'deny' | 'skip';

export interface ShellAskRequest {
    token: string;
    stepId: string;
    command: string;
    cwd: string;
    reason: string;
}

const pendingByStepId = new Map<string, ShellAskRequest>();
const listeners = new Set<() => void>();

/** Whether the conversation is currently running (tracked via conversation_running event). */
let conversationRunning = false;
const conversationListeners = new Set<() => void>();

function notify() {
    listeners.forEach((l) => l());
}

function notifyConversation() {
    conversationListeners.forEach((l) => l());
}

function parseShellAsk(payload: unknown): ShellAskRequest | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const token = typeof p.token === 'string' ? p.token : '';
    const stepId = typeof p.stepId === 'string' ? p.stepId : '';
    const command = typeof p.command === 'string' ? p.command : '';
    if (!token || !command) return null;
    return {
        token,
        stepId,
        command,
        cwd: typeof p.cwd === 'string' ? p.cwd : '',
        reason: typeof p.reason === 'string' ? p.reason : '',
    };
}

export function getShellAskForStep(stepId: string): ShellAskRequest | null {
    return pendingByStepId.get(stepId) ?? null;
}

/** Whether the conversation is currently running (V2 hasRunningTurn or tracked running state). */
export function isConversationRunning(): boolean {
    // V2: check if any turn is still running
    if (hasRunningTurn()) return true;
    return conversationRunning;
}

/** React hook to check if the conversation is currently running. */
export function useIsConversationRunning(): boolean {
    const [, tick] = useState(0);
    useEffect(() => {
        // Mount 时同步一次，确保读取到最新状态
        tick((n) => n + 1);
        const off1 = subscribeShellAsk(() => tick((n) => n + 1));
        const off2 = subscribeConversationRunning(() => tick((n) => n + 1));
        // ★ Subscribe to chatStore changes so hasRunningTurn() is re-evaluated
        // when envelope events update turn status (e.g. shell.ask arriving while
        // turn is running but conversationRunning is still false).
        const off3 = subscribeChatV2(() => tick((n) => n + 1));
        return () => { off1(); off2(); off3(); };
    }, []);
    return isConversationRunning();
}

export function subscribeConversationRunning(listener: () => void): () => void {
    conversationListeners.add(listener);
    return () => conversationListeners.delete(listener);
}

export function respondShellGrant(req: ShellAskRequest, decision: ShellGrantDecision): void {
    sendToPlugin('shell.grant', { token: req.token, decision }).catch(() => undefined);
    pendingByStepId.delete(req.stepId);
    notify();
}

export function subscribeShellAsk(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useShellAskForStep(stepId: string): ShellAskRequest | null {
    const [, tick] = useState(0);
    useEffect(() => {
        // Mount 时主动触发一次渲染，确保读取到 Map 中已有的 pending shellAsk
        // （修复 Tab 切换后组件重新挂载时，shell.ask 事件已过但 Map 中仍有数据的问题）
        tick((n) => n + 1);
        return subscribeShellAsk(() => tick((n) => n + 1));
    }, []);
    return getShellAskForStep(stepId);
}

/** Clean up stale shellAsk entries for steps that belong to finished conversations. */
export function clearStaleShellAsks(): void {
    if (isConversationRunning()) return;
    // Conversation is no longer running — clear all pending asks
    if (pendingByStepId.size === 0) return;
    pendingByStepId.clear();
    notify();
}

/** Listen for shell.ask envelopes and track conversation running state. */
export function installShellAskBridge(): () => void {
    const offEnvelope = onPluginEvent('envelope', (payload) => {
        const ev = payload as EventEnvelope;
        if (ev?.type !== 'shell.ask') return;
        const ask = parseShellAsk(ev.payload);
        if (!ask) return;
        const stepId = ask.stepId || ev.stepId;
        pendingByStepId.set(stepId, { ...ask, stepId });
        notify();
    });
    const offConvRunning = onPluginEvent('conversation_running', (payload) => {
        const running = Boolean((payload as { running?: boolean }).running);
        const prev = conversationRunning;
        conversationRunning = running;
        if (prev !== running) {
            notifyConversation();
            // When conversation stops, clear stale pending shell asks
            if (!running) {
                clearStaleShellAsks();
            }
        }
    });
    const offDone = onPluginEvent('done', (payload) => {
        const reason = (payload as { reason?: string }).reason;
        const isTerminal =
            reason === 'final' ||
            reason === 'failed' ||
            reason === 'stopped' ||
            reason === 'max_steps' ||
            reason === 'partial' ||
            reason === 'deploy_draining';
        const isAwaitingInput = reason === 'awaiting_user_input';
        if (isTerminal) {
            // ★ Always set conversationRunning to false on terminal done,
            //   even if it was already false (e.g. conversation_running(false)
            //   arrived first from a concurrent event). This ensures shell
            //   asks are always cleared and listeners are notified.
            const prev = conversationRunning;
            conversationRunning = false;
            if (prev !== conversationRunning) {
                notifyConversation();
            }
            clearStaleShellAsks();
        }
        // ★ awaiting_user_input means the stream paused but the graph will resume;
        //   keep conversationRunning true so shell.ask action buttons remain visible.
        //   However, if hasRunningTurn() is false (v2 turn was finalized/interrupted),
        //   fall back to false to avoid stuck state.
        if (isAwaitingInput) {
            const shouldRun = hasRunningTurn();
            if (conversationRunning !== shouldRun) {
                conversationRunning = shouldRun;
                notifyConversation();
            }
        }
    });
    const offInterrupted = onPluginEvent('session_interrupted', () => {
        // 会话异常终止 — 标记为非运行中，清理未执行的 shellAsk
        conversationRunning = false;
        notifyConversation();
        clearStaleShellAsks();
    });
    return () => {
        offEnvelope();
        offConvRunning();
        offDone();
        offInterrupted();
    };
}
