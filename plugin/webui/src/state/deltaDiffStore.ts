/**
 * Delta diff store — accumulates file change summaries from `delta_diff` SSE events.
 * Used by both legacy ChatView and v2 ChatViewV2 to render inline file change cards.
 */

import { onPluginEvent } from '../bridge';

export interface DeltaDiffFile {
    path: string;
    op: string;
    added: number;
    removed: number;
}

export interface DeltaDiffEntry {
    phaseId: string;
    index: number;
    total: number;
    summary?: string;
    files: DeltaDiffFile[];
    timestamp: number;
}

type Listener = (entries: DeltaDiffEntry[]) => void;

let entries: DeltaDiffEntry[] = [];
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach((l) => l(entries));
}

let installed = false;
export function installDeltaDiffBridge(): () => void {
    if (installed) return () => undefined;
    installed = true;
    const unsub = onPluginEvent('delta_diff', (payload) => {
        const data = payload as Omit<DeltaDiffEntry, 'timestamp'>;
        if (!data?.files?.length) return;
        entries = [...entries, { ...data, timestamp: Date.now() }];
        // Cap to last 50 entries
        if (entries.length > 50) entries = entries.slice(-50);
        notify();
    });
    return () => {
        installed = false;
        unsub();
    };
}

export function getDeltaDiffEntries(): DeltaDiffEntry[] {
    return entries;
}

export function subscribeDeltaDiff(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function clearDeltaDiffEntries() {
    entries = [];
    notify();
}

/** Hook-friendly: get entries for a specific turn/phase. */
export function getDeltaDiffForPhase(phaseId: string): DeltaDiffEntry[] {
    return entries.filter((e) => e.phaseId === phaseId);
}
