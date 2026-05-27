import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';

export interface RuleItem {
    id: string;
    description: string;
    globs: string[];
    alwaysApply: boolean;
    priority: number;
    body: string;
    source: string;
}

export interface MemoryItem {
    id: string;
    scope: string;
    kind: string;
    text: string;
    confidence: number;
    status: 'suggested' | 'approved' | 'rejected';
    createdAt?: number;
    updatedAt?: number;
}

interface State {
    rules: RuleItem[];
    memories: MemoryItem[];
    /** Last memory compaction notification — shows when context was compressed */
    lastCompaction: CompactionInfo | null;
}

/** Memory compaction notification data from backend CommitAction. */
export interface CompactionInfo {
    /** Marker set by backend to identify this as a compaction event */
    __COMPACTED__: boolean;
    /** Phase ID where compaction occurred */
    phaseId: string;
    /** Number of DEGRADABLE/VOLATILE memories compressed */
    compressedCount: number;
    /** Number of IMMORTAL/PROTECTED memories preserved */
    preservedCount: number;
    /** The compressed summary text */
    summary: string;
}

let state: State = { rules: [], memories: [], lastCompaction: null };
const listeners = new Set<(state: State) => void>();

function setState(next: Partial<State>) {
    state = { ...state, ...next };
    listeners.forEach((l) => l(state));
}

let installed = false;
export function installRulesMemoryBridge() {
    if (installed) return;
    installed = true;
    onPluginEvent('envelope', (raw) => {
        const env = raw as { type?: string; payload?: Record<string, unknown> };
        if (env.type === 'rules.loaded') setState({ rules: (env.payload?.rules as RuleItem[]) ?? [] });
        if (env.type === 'memory.update') setState({ memories: (env.payload?.memories as MemoryItem[]) ?? [] });
    });
    onPluginEvent('rules.response', (raw) => {
        const r = raw as { rules?: RuleItem[] };
        if (r.rules) setState({ rules: r.rules });
    });
    onPluginEvent('memory.response', (raw) => {
        const r = raw as { memories?: MemoryItem[] };
        if (r.memories) setState({ memories: r.memories });
    });
    // ── Memory compaction notification ──
    // Backend CommitAction emits memory.compacted when DEGRADABLE/VOLATILE memories
    // are compressed into a single summary at phase boundaries. This notification
    // lets the user know context was compressed, and carries the __COMPACTED__ marker
    // for session recovery detection.
    onPluginEvent('memory.compacted', (raw) => {
        const data = raw as CompactionInfo;
        if (data.__COMPACTED__) {
            setState({ lastCompaction: data });
        }
    });
}

export function getRulesMemoryState(): State { return state; }
export function subscribeRulesMemory(listener: (state: State) => void) {
    listeners.add(listener);
    listener(state);
    return () => { listeners.delete(listener); };
}

export function getPendingMemoryCount(): number {
    return state.memories.filter((m) => m.status === 'suggested').length;
}

export function usePendingMemoryCount(): number {
    const [count, setCount] = useState(getPendingMemoryCount);
    useEffect(() => {
        installRulesMemoryBridge();
        memoryApi.list().catch(() => undefined);
        return subscribeRulesMemory((s) => {
            setCount(s.memories.filter((m) => m.status === 'suggested').length);
        });
    }, []);
    return count;
}

/** Hook to get the latest compaction notification (null if none occurred). */
export function useMemoryCompaction(): CompactionInfo | null {
    const [compaction, setCompaction] = useState<CompactionInfo | null>(state.lastCompaction);
    useEffect(() => {
        installRulesMemoryBridge();
        return subscribeRulesMemory((s) => {
            setCompaction(s.lastCompaction);
        });
    }, []);
    return compaction;
}

export const rulesApi = {
    list: () => sendToPlugin('rules.list', {}),
    reload: () => sendToPlugin('rules.reload', {}),
    create: (payload: { id: string; description: string; globs: string[]; body: string }) =>
        sendToPlugin('rules.create', payload),
};

export const memoryApi = {
    list: () => sendToPlugin('memory.list', {}),
    upsert: (payload: Partial<MemoryItem> & { text: string }) => sendToPlugin('memory.upsert', payload),
    setStatus: (id: string, status: MemoryItem['status']) => sendToPlugin('memory.set_status', { id, status }),
    remove: (id: string) => sendToPlugin('memory.remove', { id }),
};
