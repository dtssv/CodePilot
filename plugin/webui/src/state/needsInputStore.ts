/**
 * Global pending needs_input from plugin (main chat session).
 */

import { useEffect, useState } from 'react';
import { onPluginEvent } from '../bridge';
import type { NeedsInputPayload } from './events';

type Listener = () => void;
const listeners = new Set<Listener>();

let pending: NeedsInputPayload | null = null;

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

export function installNeedsInputBridge(): () => void {
    return onPluginEvent('needs_input', (payload) => {
        pending = payload as NeedsInputPayload;
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
