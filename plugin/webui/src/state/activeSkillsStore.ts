/**
 * Graph node–scoped active Skills (from skills_activated SSE).
 * Current snapshot for the input bar; history is stored on each v2 TurnNode.
 */

import { useEffect, useState } from 'react';
import { onPluginEvent } from '../bridge';
import { appendTurnSkillActivation, getTurnIdForSkillEvent } from './chatStore';
import { isTerminalDoneReason } from '../utils/terminalDone';

export interface ActiveSkillItem {
    id: string;
    version?: string;
    source?: string;
    scope?: string;
    priority?: number;
    tokens?: number;
}

export interface SkillActivationRecord {
    node: string;
    skills: ActiveSkillItem[];
    ts: number;
}

export interface ActiveSkillsSnapshot {
    node: string;
    skills: ActiveSkillItem[];
    updatedAt: number;
}

let snapshot: ActiveSkillsSnapshot | null = null;
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach((l) => l());
}

export function getActiveSkillsSnapshot(): ActiveSkillsSnapshot | null {
    return snapshot;
}

export function clearActiveSkills() {
    if (snapshot === null) return;
    snapshot = null;
    notify();
}

function applySkillsActivated(payload: unknown) {
    const data = payload as {
        node?: string;
        items?: ActiveSkillItem[];
    };
    const items = (data.items ?? []).filter((i) => i?.id);
    if (items.length === 0) return;

    const ts = Date.now();
    const record: SkillActivationRecord = {
        node: data.node ?? 'UNKNOWN',
        skills: items,
        ts,
    };

    snapshot = {
        node: record.node,
        skills: items,
        updatedAt: ts,
    };

    const turnId = getTurnIdForSkillEvent();
    if (turnId) {
        appendTurnSkillActivation(turnId, record);
    }

    notify();
}

export function installActiveSkillsBridge(): () => void {
    const unsubs = [
        onPluginEvent('skills_activated', applySkillsActivated),
        onPluginEvent('chat_reset', () => clearActiveSkills()),
        onPluginEvent('done', (payload) => {
            const reason = (payload as { reason?: string })?.reason;
            if (isTerminalDoneReason(reason)) clearActiveSkills();
        }),
    ];
    return () => unsubs.forEach((off) => off());
}

export function useActiveSkills(): ActiveSkillsSnapshot | null {
    const [current, setCurrent] = useState(snapshot);
    useEffect(() => {
        const sub = () => setCurrent(snapshot);
        listeners.add(sub);
        return () => {
            listeners.delete(sub);
        };
    }, []);
    return current;
}
