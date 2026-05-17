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
}

let state: State = { rules: [], memories: [] };
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
}

export function getRulesMemoryState(): State { return state; }
export function subscribeRulesMemory(listener: (state: State) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
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
