/**
 * Smoke tests for the pending changes store. These are pure-TS assertions; the
 * tests don't require a DOM or React because the store is plain functions over
 * a module-scoped state.
 *
 * Run via `node --test` after compiling, or just by importing into a runner.
 */

import assert from 'node:assert/strict';

// We need to install the bridge BEFORE importing pending.ts so the module
// reads our fake dispatcher. The bridge module itself only writes to
// window.__codepilot_dispatch, so for Node we shim globalThis.window.
type Listener = (payload: unknown) => void;
const dispatch: Record<string, Listener[]> = {};
(globalThis as unknown as { window: Record<string, unknown> }).window = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};

import { onPluginEvent } from '../bridge';
import {
    getPending,
    installPendingBridge,
    subscribePending,
    type PendingFile,
} from './pending';

// Wire a generic capture so we can fire envelopes.
function fire(type: string, payload: unknown) {
    const fn = (globalThis as unknown as {
        window: { __codepilot_dispatch?: (t: string, p: unknown) => void };
    }).window.__codepilot_dispatch;
    if (fn) fn(type, payload);
}

// guard: keep TS happy about the unused listener map above
void dispatch; void onPluginEvent;

installPendingBridge();

const samplePending: PendingFile = {
    pendingId: 'pend-1',
    turnId: 'turn-1',
    path: 'src/a.ts',
    op: 'write',
    createdAt: 0,
    hunks: [
        {
            id: 'h0',
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            status: 'pending',
            changes: [
                { kind: 'del', text: 'old' },
                { kind: 'add', text: 'new' },
            ],
        },
    ],
};

let lastSeen: PendingFile[] = [];
subscribePending((s) => { lastSeen = s; });

// 1. pending.update envelope updates the store.
fire('envelope', { type: 'pending.update', payload: { pending: [samplePending] } });
assert.equal(getPending().length, 1, 'store should have one file');
assert.equal(getPending()[0].hunks[0].status, 'pending');
assert.equal(lastSeen.length, 1, 'subscribers should see the snapshot');

// 2. apply.list_response also drives the store.
fire('apply.list_response', { pending: [] });
assert.equal(getPending().length, 0, 'store cleared after empty list_response');

// 3. Unrelated envelopes don't affect pending state.
fire('envelope', { type: 'turn.start', payload: { userMessage: 'hi' } });
assert.equal(getPending().length, 0, 'turn.start should not modify pending state');

console.log('pending store: ok');
