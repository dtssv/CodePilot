import { useState } from 'react';
import type { PendingFile } from '../../state/pending';
import {
    applyFile,
    reapply,
    rejectFile,
    setAllHunks,
} from '../../state/pending';
import { HunkView } from './HunkView';

/**
 * Per-file change card listing every hunk. Action bar exposes
 * accept-all / reject-all / apply / discard / reapply.
 */
export function FileChangeCard({ file }: { file: PendingFile }) {
    const [open, setOpen] = useState(true);
    const accepted = file.hunks.filter((h) => h.status === 'accepted').length;
    const rejected = file.hunks.filter((h) => h.status === 'rejected').length;
    const pending = file.hunks.filter((h) => h.status === 'pending').length;

    return (
        <div className={`file-change-card op-${file.op}`}>
            <div className="file-change-header">
                <button
                    type="button"
                    className="file-toggle"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                >
                    {open ? '▼' : '▶'}
                </button>
                <span className={`file-op file-op-${file.op}`}>{file.op}</span>
                <code className="file-path">{file.path}</code>
                <span className="file-hunk-stats">
                    {file.hunks.length} hunks
                    {accepted ? ` · ${accepted} ✓` : ''}
                    {rejected ? ` · ${rejected} ✗` : ''}
                    {pending ? ` · ${pending} ?` : ''}
                </span>
                <div className="file-actions">
                    <button
                        type="button"
                        onClick={() => setAllHunks(file.pendingId, 'accepted')}
                        title="Accept all hunks"
                    >
                        Accept all
                    </button>
                    <button
                        type="button"
                        onClick={() => setAllHunks(file.pendingId, 'rejected')}
                        title="Reject all hunks"
                    >
                        Reject all
                    </button>
                    <button
                        type="button"
                        onClick={() => reapply(file.pendingId)}
                        title="Recompute against current disk"
                    >
                        Reapply
                    </button>
                    <button
                        type="button"
                        className="primary"
                        disabled={accepted === 0 && file.op !== 'delete'}
                        onClick={() => applyFile(file.pendingId)}
                        title="Commit accepted hunks to disk"
                    >
                        Apply
                    </button>
                    <button
                        type="button"
                        className="danger"
                        onClick={() => rejectFile(file.pendingId)}
                        title="Discard all pending changes for this file"
                    >
                        Discard
                    </button>
                </div>
            </div>
            {open && (
                <div className="file-hunks">
                    {file.hunks.length === 0 ? (
                        <div className="file-empty">
                            (no diff — {file.op === 'delete' ? 'file will be deleted' : 'content identical'})
                        </div>
                    ) : (
                        file.hunks.map((h) => (
                            <HunkView key={h.id} pendingId={file.pendingId} hunk={h} />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
