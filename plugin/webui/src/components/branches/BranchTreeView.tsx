import { sendToPlugin } from '../../bridge';
import type { ReactNode } from 'react';

export interface BranchNode {
    branchId: string;
    sessionId: string;
    parentBranchId: string | null;
    forkMsgIndex: number | null;
    title: string;
    createdAt?: string | number;
    messageCount: number;
    active: boolean;
}

interface TreeNode {
    branch: BranchNode;
    children: TreeNode[];
    depth: number;
}

function buildTree(branches: BranchNode[]): TreeNode[] {
    const byParent = new Map<string | null, BranchNode[]>();
    for (const branch of branches) {
        const arr = byParent.get(branch.parentBranchId) ?? [];
        arr.push(branch);
        byParent.set(branch.parentBranchId, arr);
    }
    const walk = (parent: string | null, depth: number): TreeNode[] =>
        (byParent.get(parent) ?? [])
            .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
            .map((branch) => ({ branch, depth, children: walk(branch.branchId, depth + 1) }));
    const roots = walk(null, 0);
    return roots.length > 0 ? roots : walk('main', 0);
}

export function BranchTreeView({ branches }: { branches: BranchNode[] }) {
    if (branches.length <= 1) return null;
    const tree = buildTree(branches);
    const render = (node: TreeNode): ReactNode => (
        <div key={node.branch.branchId} className="branch-node" style={{ marginLeft: node.depth * 14 }}>
            <div className={`branch-row ${node.branch.active ? 'active' : ''}`}>
                <span className="branch-glyph">{node.depth > 0 ? '└─' : '●'}</span>
                <button
                    type="button"
                    className="branch-title"
                    onClick={() => sendToPlugin('switch_branch', { sessionId: node.branch.sessionId })}
                >
                    {node.branch.title || node.branch.branchId}
                </button>
                {node.branch.forkMsgIndex != null && <span className="branch-fork">fork @ #{node.branch.forkMsgIndex}</span>}
                <span className="branch-meta">{node.branch.messageCount} msgs</span>
                {!node.branch.active && (
                    <button
                        type="button"
                        className="branch-delete"
                        onClick={() => sendToPlugin('delete_session', { sessionId: node.branch.sessionId })}
                        title="Delete branch"
                    >
                        ×
                    </button>
                )}
            </div>
            {node.children.map(render)}
        </div>
    );
    return <div className="branch-tree">{tree.map(render)}</div>;
}
