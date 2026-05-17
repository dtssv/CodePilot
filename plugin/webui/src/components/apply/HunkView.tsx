import type { PendingHunk } from '../../state/pending';
import { setHunkStatus } from '../../state/pending';

/**
 * Renders a single hunk as a unified diff with accept/reject buttons.
 */
export function HunkView({
    pendingId,
    hunk,
}: {
    pendingId: string;
    hunk: PendingHunk;
}) {
    const status = hunk.status;
    return (
        <div className={`hunk-view hunk-status-${status}`}>
            <div className="hunk-header">
                <span className="hunk-range">
                    @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                </span>
                <span className="hunk-status">{status}</span>
                <button
                    type="button"
                    className="hunk-btn hunk-btn-accept"
                    aria-pressed={status === 'accepted'}
                    onClick={() => setHunkStatus(pendingId, hunk.id, 'accepted')}
                    title="Accept this hunk"
                >
                    ✓ Accept
                </button>
                <button
                    type="button"
                    className="hunk-btn hunk-btn-reject"
                    aria-pressed={status === 'rejected'}
                    onClick={() => setHunkStatus(pendingId, hunk.id, 'rejected')}
                    title="Reject this hunk"
                >
                    ✗ Reject
                </button>
            </div>
            <pre className="hunk-diff">
                {hunk.changes.map((c, i) => (
                    <div key={i} className={`hunk-line hunk-line-${c.kind}`}>
                        <span className="hunk-sigil">
                            {c.kind === 'add' ? '+' : c.kind === 'del' ? '-' : ' '}
                        </span>
                        <span className="hunk-text">{c.text || ' '}</span>
                    </div>
                ))}
            </pre>
        </div>
    );
}
