/**
 * P0-03 — Pending changes store.
 *
 * Listens for `pending.update` envelopes (and the synchronous `apply.list_response`
 * snapshot) from the plugin and maintains a typed view of pending file edits the
 * user can accept/reject hunk-by-hunk.
 */

import { onPluginEvent, sendToPlugin } from '../bridge';

export type HunkStatus = 'pending' | 'accepted' | 'rejected';
export type PendingOp = 'create' | 'write' | 'delete';

export interface HunkChange {
    kind: 'ctx' | 'add' | 'del';
    text: string;
}

export interface PendingHunk {
    id: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    status: HunkStatus;
    changes: HunkChange[];
}

export interface PendingFile {
    pendingId: string;
    turnId: string;
    path: string;
    op: PendingOp;
    createdAt: number;
    hunks: PendingHunk[];
}

type Listener = (state: PendingFile[]) => void;

let state: PendingFile[] = [];
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach((l) => l(state));
}

function ingest(snapshot: PendingFile[]) {
    state = (snapshot ?? []).map((p) => ({
        ...p,
        hunks: (p.hunks ?? []).map((h) => ({ ...h, changes: h.changes ?? [] })),
    }));
    notify();
}

/** Wire envelope + list_response handlers. Idempotent. */
let installed = false;
export function installPendingBridge() {
    if (installed) return;
    installed = true;
    onPluginEvent('envelope', (envRaw) => {
        const env = envRaw as { type?: string; payload?: { pending?: PendingFile[] } };
        if (env?.type === 'pending.update' && env.payload?.pending) {
            ingest(env.payload.pending);
        }
    });
    onPluginEvent('apply.list_response', (raw) => {
        const p = (raw as { pending?: PendingFile[] })?.pending;
        if (p) ingest(p);
    });
}

export function getPending(): PendingFile[] {
    return state;
}

export function subscribePending(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// ---------- actions ---------- //

export function requestPendingList(): Promise<string> {
    return sendToPlugin('apply.list', {});
}

export function setHunkStatus(pendingId: string, hunkId: string, status: HunkStatus) {
    return sendToPlugin('apply.hunk_status', { pendingId, hunkId, status });
}

export function setAllHunks(pendingId: string, status: HunkStatus) {
    return sendToPlugin('apply.hunk_status', { pendingId, hunkId: '*', status });
}

export function applyFile(pendingId: string) {
    return sendToPlugin('apply.apply_file', { pendingId });
}

export function applyAll(turnId: string) {
    return sendToPlugin('apply.apply_all', { turnId });
}

export function rejectFile(pendingId: string) {
    return sendToPlugin('apply.reject_file', { pendingId });
}

export function reapply(pendingId: string) {
    return sendToPlugin('apply.reapply', { pendingId });
}

export function undoTurn(turnId: string) {
    return sendToPlugin('apply.undo_turn', { turnId });
}
