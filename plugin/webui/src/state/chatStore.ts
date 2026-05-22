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
import { isTerminalDoneReason } from '../utils/terminalDone';
import { buildV2StateFromLegacyMessages, type LegacyHydrateMessage } from './chatHydrate';
import { INITIAL_V2_STATE, type ChatV2State, type EventEnvelope, type SkillActivationRecord } from './events';
import { applyEnvelope, reduceEnvelope } from './turnReducer';

type Listener = (s: ChatV2State) => void;

let state: ChatV2State = INITIAL_V2_STATE;
const listeners = new Set<Listener>();

/** After new chat, ignore stale envelopes until the user starts a new turn. */
let suppressEnvelopesUntilTurnStart = false;

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

/** Prefer running turn; else last turn in the session (skills may arrive slightly after turn.end). */
export function getTurnIdForSkillEvent(): string | null {
    if (state.turns.length === 0) return null;
    const running = [...state.turns].reverse().find((t) => t.status === 'running');
    if (running) return running.turnId;
    return state.turns[state.turns.length - 1]?.turnId ?? null;
}

export function appendTurnSkillActivation(turnId: string, record: SkillActivationRecord) {
    const turns = state.turns.map((t) => {
        if (t.turnId !== turnId) return t;
        const prev = t.skillActivations ?? [];
        return { ...t, skillActivations: [...prev, record] };
    });
    if (!turns.some((t) => t.turnId === turnId)) return;
    setState({ ...state, turns });
}

/** True while any turn is still running (blocks destructive session hydration). */
export function hasRunningTurn(): boolean {
    return state.turns.some((t) => t.status === 'running');
}

export function subscribeChatV2(l: Listener): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export interface ResetChatV2Options {
    /** When true, drop envelopes until the next turn.start (new chat only). */
    suppressEnvelopes?: boolean;
}

/** Reset the store — used when switching sessions in v2 UI. */
export function resetChatV2(replayBaseline?: number, opts?: ResetChatV2Options) {
    suppressEnvelopesUntilTurnStart = opts?.suppressEnvelopes === true;
    setState({
        ...INITIAL_V2_STATE,
        lastSeq: typeof replayBaseline === 'number' ? replayBaseline : INITIAL_V2_STATE.lastSeq,
    });
}

/** After hydrating history, align seq cursor so replay_since does not replay live buffer.
 *  Takes the max of the current lastSeq and the provided seq to avoid regressing
 *  the cursor (which would cause duplicate envelope replay and layout thrashing). */
export function setChatV2LastSeq(seq: number) {
    if (typeof seq !== 'number' || seq < 0) return;
    if (seq <= state.lastSeq) return;
    setState({ ...state, lastSeq: seq });
}

/** Force-close stuck running turns/steps when the plugin reports idle (conversation ended). */
export function finalizeRunningTurns() {
    const hasRunningTurns = state.turns.some((t) => t.status === 'running');
    const hasRunningSteps = Object.values(state.steps).some((s) => s.status === 'running');
    if (!hasRunningTurns && !hasRunningSteps) return;
    const now = Date.now();
    const steps = { ...state.steps };
    for (const [id, step] of Object.entries(steps)) {
        if (step.status === 'running') {
            steps[id] = { ...step, status: 'success', endedAt: now };
        }
    }
    setState({
        ...state,
        steps,
        turns: state.turns.map((t) =>
            t.status === 'running'
                ? { ...t, status: 'final' as const, endedAt: now, reason: 'final' }
                : t,
        ),
    });
}

/** Mark the latest running turn as interrupted (e.g. awaiting_user_input). */
export function interruptRunningTurns() {
    const hasRunningTurns = state.turns.some((t) => t.status === 'running');
    if (!hasRunningTurns) return;
    setState({
        ...state,
        turns: state.turns.map((t) =>
            t.status === 'running'
                ? { ...t, status: 'interrupted' as const, reason: 'awaiting_user_input' }
                : t,
        ),
    });
}

/** Resume an interrupted turn back to running (e.g. after user answers askUser). */
export function resumeInterruptedTurns() {
    const hasInterruptedTurns = state.turns.some((t) => t.status === 'interrupted');
    if (!hasInterruptedTurns) return;
    setState({
        ...state,
        turns: state.turns.map((t) =>
            t.status === 'interrupted'
                ? { ...t, status: 'running' as const, reason: null }
                : t,
        ),
    });
}

/** Restore v2 turn tree from legacy session_messages (Integrated → Productized). */
export function hydrateChatV2FromLegacyMessages(messages: LegacyHydrateMessage[]) {
    suppressEnvelopesUntilTurnStart = false;
    setState(buildV2StateFromLegacyMessages(messages));
}

/** Restore v2 state by replaying persisted envelopes (exact chronological order). */
export function hydrateChatV2FromEnvelopes(envelopes: EventEnvelope[]) {
    suppressEnvelopesUntilTurnStart = false;
    const sorted = [...envelopes].sort((a, b) => a.seq - b.seq);
    let next = INITIAL_V2_STATE;
    for (const ev of sorted) {
        if (ev.seq <= next.lastSeq) continue;
        next = reduceEnvelope(next, ev);
    }
    setState(next);
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
    const unsubDone = onPluginEvent('done', (payload) => {
        const reason = (payload as { reason?: string }).reason;
        if (isTerminalDoneReason(reason)) {
            finalizeRunningTurns();
        } else if (reason === 'awaiting_user_input') {
            // Turn is interrupted waiting for user input — mark as interrupted
            interruptRunningTurns();
        }
    });
    const unsub = onPluginEvent('envelope', (payload) => {
        const ev = payload as EventEnvelope;
        if (!ev || typeof ev.seq !== 'number') return;
        if (suppressEnvelopesUntilTurnStart) {
            if (ev.type === 'turn.start') {
                suppressEnvelopesUntilTurnStart = false;
            } else {
                return;
            }
        }
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
        unsubDone();
    };
}

// Auto-install when imported. Components that don't import this file remain
// completely unaffected.
installChatV2Bridge();
