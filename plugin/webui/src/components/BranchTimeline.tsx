import { useState } from 'react';

/**
 * Branch Timeline visualization for conversation branching.
 *
 * Renders a vertical timeline showing:
 * - Main conversation branch as the center column
 * - Forked branches as side branches
 * - Active branch highlighted
 * - Click to switch between branches
 */

export interface BranchInfo {
    branchId: string;
    parentBranchId?: string;
    parentMsgIndex?: number;
    title: string;
    messageCount: number;
    lastMessageAt?: string;
}

interface BranchTimelineProps {
    branches: BranchInfo[];
    activeBranchId: string;
    onSwitchBranch: (branchId: string) => void;
}

export function BranchTimeline({ branches, activeBranchId, onSwitchBranch }: BranchTimelineProps) {
    const [expanded, setExpanded] = useState(false);

    if (branches.length <= 1) return null;

    const mainBranch = branches.find(b => !b.parentBranchId) || branches[0];
    const forkBranches = branches.filter(b => b.parentBranchId);

    return (
        <div className="branch-timeline">
            <button
                className="branch-toggle"
                onClick={() => setExpanded(!expanded)}
                title="Conversation branches"
            >
                <span className="branch-icon">⑂</span>
                <span className="branch-count">{branches.length}</span>
            </button>

            {expanded && (
                <div className="branch-panel">
                    <div className="branch-header">Branches</div>
                    <div className="branch-list">
                        <div
                            className={`branch-item ${mainBranch.branchId === activeBranchId ? 'active' : ''}`}
                            onClick={() => onSwitchBranch(mainBranch.branchId)}
                        >
                            <div className="branch-dot main" />
                            <div className="branch-info">
                                <div className="branch-name">{mainBranch.title || 'Main'}</div>
                                <div className="branch-meta">
                                    {mainBranch.messageCount} messages
                                    {mainBranch.lastMessageAt && (
                                        <span className="branch-time"> · {formatTime(mainBranch.lastMessageAt)}</span>
                                    )}
                                </div>
                            </div>
                            {mainBranch.branchId === activeBranchId && (
                                <span className="branch-active-indicator">●</span>
                            )}
                        </div>

                        {forkBranches.map(fork => (
                            <div
                                key={fork.branchId}
                                className={`branch-item fork ${fork.branchId === activeBranchId ? 'active' : ''}`}
                                onClick={() => onSwitchBranch(fork.branchId)}
                            >
                                <div className="branch-connector">
                                    <div className="connector-line" />
                                    <div className="branch-dot fork" />
                                </div>
                                <div className="branch-info">
                                    <div className="branch-name">{fork.title || `Fork at msg #${fork.parentMsgIndex}`}</div>
                                    <div className="branch-meta">
                                        {fork.messageCount} messages
                                        {fork.lastMessageAt && (
                                            <span className="branch-time"> · {formatTime(fork.lastMessageAt)}</span>
                                        )}
                                    </div>
                                </div>
                                {fork.branchId === activeBranchId && (
                                    <span className="branch-active-indicator">●</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function formatTime(ts: string): string {
    try {
        const d = new Date(ts);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        return d.toLocaleDateString();
    } catch {
        return ts;
    }
}