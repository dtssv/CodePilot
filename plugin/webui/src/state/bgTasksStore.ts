/**
 * Background task counts for tab badges and polling hints.
 */

import { useEffect, useState } from 'react';

type Listener = () => void;
const listeners = new Set<Listener>();

let activeCount = 0;

function notify() {
    listeners.forEach((l) => l());
}

export function setBackgroundActiveCount(count: number) {
    const n = Math.max(0, count);
    if (n === activeCount) return;
    activeCount = n;
    notify();
}

export function getBackgroundActiveCount(): number {
    return activeCount;
}

export function useBackgroundActiveCount(): number {
    const [n, setN] = useState(activeCount);
    useEffect(() => {
        const sub = () => setN(activeCount);
        listeners.add(sub);
        return () => { listeners.delete(sub); };
    }, []);
    return n;
}
