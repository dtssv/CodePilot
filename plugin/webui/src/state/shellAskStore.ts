/**
 * Pending shell.exec permission (plugin envelope shell.ask → WebUI inline actions).
 */

import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
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

function notify() {
    listeners.forEach((l) => l());
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
    useEffect(() => subscribeShellAsk(() => tick((n) => n + 1)), []);
    return getShellAskForStep(stepId);
}

/** Listen for shell.ask envelopes from the v2 event bus. */
export function installShellAskBridge(): () => void {
    return onPluginEvent('envelope', (payload) => {
        const ev = payload as EventEnvelope;
        if (ev?.type !== 'shell.ask') return;
        const ask = parseShellAsk(ev.payload);
        if (!ask) return;
        const stepId = ask.stepId || ev.stepId;
        pendingByStepId.set(stepId, { ...ask, stepId });
        notify();
    });
}
