import { onPluginEvent, sendToPlugin } from '../bridge';

export type CodebaseState = 'idle' | 'scanning' | 'indexing' | 'paused' | 'error';

export interface CodebaseStatus {
    state: CodebaseState;
    totalFiles: number;
    indexedFiles: number;
    failedFiles: number;
    lastIndexedAt?: number;
    embeddingModel: string;
    ignored: string[];
    error?: string;
}

export interface CodebaseHit {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    symbols?: string[];
    matchType?: string;
}

export interface CodebaseSearchResult {
    query: string;
    hits: CodebaseHit[];
    durationMs: number;
}

interface State {
    status: CodebaseStatus;
    lastSearch?: CodebaseSearchResult;
}

const EMPTY_STATUS: CodebaseStatus = {
    state: 'idle',
    totalFiles: 0,
    indexedFiles: 0,
    failedFiles: 0,
    embeddingModel: 'local-tfidf',
    ignored: [],
};

let state: State = { status: EMPTY_STATUS };
const listeners = new Set<(state: State) => void>();

function setState(next: Partial<State>) {
    state = { ...state, ...next };
    listeners.forEach((l) => l(state));
}

function normalizeStatus(raw: unknown): CodebaseStatus {
    const s = raw as Partial<CodebaseStatus> | undefined;
    return {
        ...EMPTY_STATUS,
        ...(s ?? {}),
        ignored: Array.isArray(s?.ignored) ? s!.ignored! : [],
    };
}

let installed = false;
export function installCodebaseBridge() {
    if (installed) return;
    installed = true;
    onPluginEvent('envelope', (envRaw) => {
        const env = envRaw as { type?: string; payload?: unknown };
        if (env.type === 'codebase.status') setState({ status: normalizeStatus(env.payload) });
        if (env.type === 'codebase.search.result') {
            setState({ lastSearch: env.payload as CodebaseSearchResult });
        }
    });
    onPluginEvent('codebase.status_response', (raw) => {
        setState({ status: normalizeStatus(raw) });
    });
    onPluginEvent('codebase.search_response', (raw) => {
        setState({ lastSearch: raw as CodebaseSearchResult });
    });
}

export function getCodebaseState(): State {
    return state;
}

export function subscribeCodebase(listener: (state: State) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function requestCodebaseStatus() {
    return sendToPlugin('codebase.get_status', {});
}

export function rebuildCodebase() {
    return sendToPlugin('codebase.rebuild', {});
}

export function pauseCodebase() {
    return sendToPlugin('codebase.pause', {});
}

export function resumeCodebase() {
    return sendToPlugin('codebase.resume', {});
}

export function searchCodebase(query: string, topK = 12) {
    return sendToPlugin('codebase.search', { query, topK });
}

export function setCodebaseIgnore(patterns: string[]) {
    return sendToPlugin('codebase.set_ignore', { patterns });
}
