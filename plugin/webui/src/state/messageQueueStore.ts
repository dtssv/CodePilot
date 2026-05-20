/**
 * Pending user messages waiting for the current graph turn to finish (plugin-side FIFO).
 */

import { useEffect, useState } from 'react';
import { onPluginEvent } from '../bridge';

export interface QueuedMessagePreview {
    text: string;
    mode?: string;
}

type Listener = (items: QueuedMessagePreview[]) => void;

let queue: QueuedMessagePreview[] = [];
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach((l) => l([...queue]));
}

export function setMessageQueue(items: QueuedMessagePreview[]) {
    queue = items;
    notify();
}

export function subscribeMessageQueue(l: Listener): () => void {
    listeners.add(l);
    l([...queue]);
    return () => listeners.delete(l);
}

export function useMessageQueue(): QueuedMessagePreview[] {
    const [items, setItems] = useState<QueuedMessagePreview[]>(queue);
    useEffect(() => subscribeMessageQueue(setItems), []);
    return items;
}

/** Wire plugin queue events. */
export function installMessageQueueBridge(): () => void {
    const off = onPluginEvent('message_queue_updated', (payload) => {
        const data = payload as { pending?: { text?: string; mode?: string }[] };
        setMessageQueue(
            (data.pending ?? []).map((p) => ({
                text: p.text ?? '',
                mode: p.mode,
            })),
        );
    });
    return off;
}
