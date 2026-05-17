import { useEffect, useState } from 'react';
import {
    applyAll,
    getPending,
    installPendingBridge,
    requestPendingList,
    subscribePending,
    undoTurn,
    type PendingFile,
} from '../../state/pending';
import { FileChangeCard } from './FileChangeCard';

/**
 * Top-level panel that lists every pending file from the active turn. Mount
 * once at the App level (opt-in via the staging feature flag) and it stays in
 * sync with the plugin host via the `pending.update` envelope stream.
 */
export function ChangePanel() {
    const [files, setFiles] = useState<PendingFile[]>(getPending());

    useEffect(() => {
        installPendingBridge();
        const unsub = subscribePending(setFiles);
        requestPendingList().catch(() => undefined);
        return unsub;
    }, []);

    if (files.length === 0) return null;

    // Group by turn so a single banner Apply-All / Undo can target the right scope.
    const byTurn = new Map<string, PendingFile[]>();
    for (const f of files) {
        const arr = byTurn.get(f.turnId) ?? [];
        arr.push(f);
        byTurn.set(f.turnId, arr);
    }

    return (
        <div className="change-panel" data-testid="change-panel">
            {[...byTurn.entries()].map(([turnId, turnFiles]) => (
                <section key={turnId} className="change-panel-turn">
                    <header className="change-panel-header">
                        <h3 className="change-panel-title">
                            Pending changes
                            <span className="change-panel-turn-id">({turnFiles.length} files)</span>
                        </h3>
                        <div className="change-panel-actions">
                            <button
                                type="button"
                                className="primary"
                                onClick={() => applyAll(turnId)}
                                title="Apply every file with at least one accepted hunk"
                            >
                                Apply all
                            </button>
                            <button
                                type="button"
                                onClick={() => undoTurn(turnId)}
                                title="Undo all committed changes from this turn"
                            >
                                Undo turn
                            </button>
                        </div>
                    </header>
                    <div className="change-panel-files">
                        {turnFiles.map((f) => (
                            <FileChangeCard key={f.pendingId} file={f} />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
