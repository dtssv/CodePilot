import { useEffect, useState } from 'react';
import { onPluginEvent } from '../../bridge';

/**
 * P0-04 — Subscribes to `inline.*` envelopes and renders a compact timeline
 * card per inline edit so the user can revisit recent in-editor edits from the
 * chat surface. Lives in the side panel (mount once at App level).
 */

type Status = 'streaming' | 'ready' | 'accepted' | 'rejected' | 'failed';
interface Entry {
    turnId: string;
    filePath: string;
    intent?: string;
    status: Status;
    ts: number;
    error?: string;
}

const MAX_ENTRIES = 12;

export function InlineEditTimeline() {
    const [entries, setEntries] = useState<Entry[]>([]);

    useEffect(() => {
        const off = onPluginEvent('envelope', (raw) => {
            const env = raw as {
                type?: string;
                turnId?: string;
                payload?: Record<string, unknown>;
            };
            if (!env?.type?.startsWith('inline.')) return;
            const turnId = env.turnId ?? 'inline';
            setEntries((prev) => {
                const existingIdx = prev.findIndex((e) => e.turnId === turnId);
                const ts = Date.now();
                const path = (env.payload?.filePath as string) ?? '<unknown>';
                const next = prev.slice();
                if (env.type === 'inline.open') {
                    const entry: Entry = {
                        turnId, filePath: path, ts, status: 'streaming',
                        intent: env.payload?.intent as string | undefined,
                    };
                    if (existingIdx >= 0) next[existingIdx] = entry;
                    else next.unshift(entry);
                } else if (existingIdx >= 0) {
                    const e = { ...next[existingIdx], ts };
                    switch (env.type) {
                        case 'inline.done': e.status = 'ready'; break;
                        case 'inline.accept': e.status = 'accepted'; break;
                        case 'inline.reject': e.status = 'rejected'; break;
                        case 'inline.error': {
                            e.status = 'failed';
                            e.error = env.payload?.reason as string | undefined;
                            break;
                        }
                    }
                    next[existingIdx] = e;
                }
                return next.slice(0, MAX_ENTRIES);
            });
        });
        return off;
    }, []);

    if (entries.length === 0) return null;

    return (
        <div className="inline-edit-timeline">
            <header><h4>Inline edits</h4></header>
            <ul>
                {entries.map((e) => (
                    <li key={e.turnId} className={`inline-edit-row status-${e.status}`}>
                        <code className="inline-edit-path">{e.filePath}</code>
                        <span className="inline-edit-status">{e.status}</span>
                        {e.intent && <span className="inline-edit-intent" title={e.intent}>{e.intent}</span>}
                        {e.error && <span className="inline-edit-error">{e.error}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}
