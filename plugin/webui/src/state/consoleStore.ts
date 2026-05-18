/**
 * Console panel state — extracted from App.tsx.
 */

import { useEffect, useState } from 'react';
import type { ConsoleEntry } from '../components/ConsolePanel';

type Listener = (entries: ConsoleEntry[]) => void;

let entries: ConsoleEntry[] = [];
let nextId = 0;
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach((l) => l(entries));
}

export function getConsoleEntries(): ConsoleEntry[] {
    return entries;
}

export function subscribeConsole(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
}

export function logConsole(type: ConsoleEntry['type'], source: string, data: unknown) {
    const entry: ConsoleEntry = {
        id: `console-${++nextId}`,
        timestamp: new Date(),
        type,
        source,
        data,
    };
    entries = [...entries.slice(-500), entry];
    notify();
}

export function clearConsole() {
    entries = [];
    notify();
}

export function useConsoleEntries(): ConsoleEntry[] {
    const [slice, setSlice] = useState(entries);
    useEffect(() => subscribeConsole(setSlice), []);
    return slice;
}
