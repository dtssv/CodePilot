/**
 * v2 chat store.
 *
 * Bound to the `envelope` event from the plugin host. Uses a tiny pub/sub so
 * components can subscribe with a selector without pulling in a new dependency
 * (no zustand / redux). The legacy App.tsx state remains untouched.
 *
 * Enabled by default. Opt out: localStorage.setItem('codepilot.protocol.v2', '0')
 */

import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
import { buildV2StateFromLegacyMessages, type LegacyHydrateMessage } from './chatHydrate';
import { applyEnvelope } from './turnReducer';
import { INITIAL_V2_STATE, type ChatV2State, type EventEnvelope } from './events';

type Listener = (s: ChatV2State) => void;

let state: ChatV2State = INITIAL_V2_STATE;
const listeners = new Set<Listener>();

/** Throttle for replay_since requests so we don't spam on a long gap burst. */
let lastReplayRequestAt = 0;
const REPLAY_THROTTLE_MS = 250;

function setState(next: ChatV2State) {
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l(state));
}

export function getChatV2State(): ChatV2State {
    return state;
}

export function subscribeChatV2(l: Listener): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

/** Reset the store — used when switching sessions in v2 UI. */
export function resetChatV2() {
    setState(INITIAL_V2_STATE);
}

/** Restore v2 turn tree from legacy session_messages (Integrated → Productized). */
export function hydrateChatV2FromLegacyMessages(messages: LegacyHydrateMessage[]) {
    setState(buildV2StateFromLegacyMessages(messages));
}

/**
 * Hook with selector + shallow equality (default: reference equality).
 *
 * Usage:
 *   const turns = useChatV2(s => s.turns);
 *   const step  = useChatV2(s => s.steps[id]);
 */
export function useChatV2<T>(selector: (s: ChatV2State) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
    const [slice, setSlice] = useState<T>(() => selector(state));
    useEffect(() => {
        let prev = slice;
        const unsub = subscribeChatV2((s) => {
            const next = selector(s);
            if (!isEqual(prev, next)) {
                prev = next;
                setSlice(next);
            }
        });
        return unsub;
        // selector & isEqual are intentionally stable references in callers;
        // re-subscribing on every change would defeat the purpose of the hook.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return slice;
}

/** Whether the v2 protocol is enabled for this session (default: on). */
export function isV2Enabled(): boolean {
    try {
        if (typeof localStorage === 'undefined') return true;
        const flag = localStorage.getItem('codepilot.protocol.v2');
        if (flag === '0') return false;
        return true;
    } catch {
        return true;
    }
}

/**
 * Install the global envelope listener. Idempotent — safe to call multiple times.
 * Returns an unsubscribe function for tests.
 */
let installed = false;
export function installChatV2Bridge(): () => void {
    if (installed) return () => undefined;
    installed = true;
    const unsub = onPluginEvent('envelope', (payload) => {
        const ev = payload as EventEnvelope;
        if (!ev || typeof ev.seq !== 'number') return;
        const { next, requestReplayFrom } = applyEnvelope(state, ev);
        setState(next);
        if (requestReplayFrom !== undefined) {
            const now = Date.now();
            if (now - lastReplayRequestAt > REPLAY_THROTTLE_MS) {
                lastReplayRequestAt = now;
                sendToPlugin('replay_since', { lastSeq: requestReplayFrom }).catch(() => undefined);
            }
        }
    });
    return () => {
        installed = false;
        unsub();
    };
}

// Auto-install when imported. Components that don't import this file remain
// completely unaffected.
installChatV2Bridge();
