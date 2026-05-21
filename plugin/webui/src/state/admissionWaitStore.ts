/**
 * Agent admission / server backoff — UI is waiting for a run slot, not actively streaming.
 */

import { useEffect, useState } from 'react';

export interface AdmissionWaitState {
    message: string;
    attempt: number;
    maxAttempts: number;
    retryAfterSec: number;
    userQueued?: number;
    userRunning?: number;
    globalQueued?: number;
    globalRunning?: number;
    /** When true, max retries exhausted — user must confirm to keep retrying. */
    askRetry: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let state: AdmissionWaitState | null = null;

export function getAdmissionWaitState(): AdmissionWaitState | null {
    return state;
}

export function setAdmissionWaitState(s: AdmissionWaitState | null) {
    state = s;
    listeners.forEach((l) => l());
}

export function subscribeAdmissionWait(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useAdmissionWaitState(): AdmissionWaitState | null {
    const [s, setS] = useState<AdmissionWaitState | null>(() => state);
    useEffect(() => subscribeAdmissionWait(() => setS(state)), []);
    return s;
}