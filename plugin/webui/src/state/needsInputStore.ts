/**
 * Global pending needs_input from plugin (main chat session).
 * Tracks submitted continuationTokens so all NeedsInputCard instances
 * (dock + inline message) share the same "already answered" state.
 */

import { useEffect, useState } from 'react';
import { onPluginEvent } from '../bridge';
import type { NeedsInputPayload } from './events';

type Listener = () => void;
const listeners = new Set<Listener>();

let pending: NeedsInputPayload | null = null;

/** Set of continuationTokens that have been submitted — prevents double-submit. */
const submittedTokens = new Set<string>();

function notify() {
    listeners.forEach((l) => l());
}

export function getPendingNeedsInput(): NeedsInputPayload | null {
    return pending;
}

export function clearPendingNeedsInput(): void {
    if (!pending) return;
    pending = null;
    notify();
}

/** Mark a continuationToken as submitted — all card instances will disable themselves. */
export function markNeedsInputSubmitted(token: string | undefined | null): void {
    if (!token) return;
    submittedTokens.add(token);
    notify();
}

/** Check if a continuationToken has already been submitted. */
export function isNeedsInputSubmitted(token: string | undefined | null): boolean {
    if (!token) return false;
    return submittedTokens.has(token);
}

export function installNeedsInputBridge(): () => void {
    return onPluginEvent('needs_input', (payload) => {
        pending = payload as NeedsInputPayload;
        // Clear any previous submitted state for this new needs_input
        submittedTokens.clear();
        notify();
    });
}

export function usePendingNeedsInput(): NeedsInputPayload | null {
    const [value, setValue] = useState(pending);
    useEffect(() => {
        const sub = () => setValue(pending);
        listeners.add(sub);
        return () => { listeners.delete(sub); };
    }, []);
    return value;
}

/** React hook: returns true if the given continuationToken has been submitted. */
export function useNeedsInputSubmitted(token: string | undefined | null): boolean {
    const [submitted, setSubmitted] = useState(() => isNeedsInputSubmitted(token));
    useEffect(() => {
        const sub = () => setSubmitted(isNeedsInputSubmitted(token));
        listeners.add(sub);
        return () => { listeners.delete(sub); };
    }, [token]);
    return submitted;
}