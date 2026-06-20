import { useEffect, useState } from 'react';
import { sendToPlugin } from '../bridge';
import type { DeltaDiffEntry, DeltaDiffFile } from '../state/deltaDiffStore';
import {
    getDeltaDiffEntries,
    installDeltaDiffBridge,
    subscribeDeltaDiff,
} from '../state/deltaDiffStore';

function formatLines(n: number): string {
    if (n === 0) return '0';
    return n > 0 ? `+${n}` : `${n}`;
}

function getActionLabel(op: string): string {
    switch (op) {
        case 'create': return '新建';
        case 'delete': return '删除';
        case 'replace':
        case 'modify':
        case 'write': return '修改';
        case 'rename': return '重命名';
        default: return op;
    }
}

function getActionIcon(op: string): string {
    switch (op) {
        case 'create': return '✨';
        case 'delete': return '🗑️';
        case 'replace':
        case 'modify':
        case 'write': return '✏️';
        case 'rename': return '📋';
        default: return '📄';
    }
}

function getActionColor(op: string): string {
    switch (op) {
        case 'create': return '#2ea043';
        case 'delete': return '#cf222e';
        case 'replace':
        case 'modify':
        case 'write': return '#d29922';
        case 'rename': return '#8250df';
        default: return '#656d76';
    }
}

function FileRow({ file, onOpen }: { file: DeltaDiffFile; onOpen: (path: string) => void }) {
    const op = file.op || 'write';
    const actionColor = getActionColor(op);
    const actionLabel = getActionLabel(op);
    const actionIcon = getActionIcon(op);
    const fileName = file.path.split('/').pop() || file.path;
    const dir = file.path.split('/').slice(0, -1).join('/');

    return (
        <div
            className="file-diff-row"
            onClick={() => onOpen(file.path)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(file.path); }}
        >
            <div className="file-diff-row-left">
                <span className="file-diff-action-icon">{actionIcon}</span>
                <span className="file-diff-filename" title={file.path}>{fileName}</span>
                {dir && <span className="file-diff-dir" title={file.path}> in {dir}</span>}
                <span
                    className="file-diff-action-badge"
                    style={{ color: actionColor, borderColor: actionColor }}
                >
                    {actionLabel}
                </span>
            </div>
            <div className="file-diff-row-right">
                <span className="file-diff-stat">
                    <span className="file-diff-add">{formatLines(file.added)}</span>
                    <span className="file-diff-del">-{file.removed}</span>
                </span>
            </div>
        </div>
    );
}

/**
 * Renders all accumulated delta_diff entries as an inline file change summary.
 * Self-subscribes to the global deltaDiffStore.
 */
export function FileDiffSummaryCard() {
    const [entries, setEntries] = useState<DeltaDiffEntry[]>(getDeltaDiffEntries);

    useEffect(() => {
        const off = installDeltaDiffBridge();
        const unsub = subscribeDeltaDiff(setEntries);
        return () => {
            off();
            unsub();
        };
    }, []);

    if (entries.length === 0) return null;

    // Merge all entries into a single summary
    const allFiles = entries.flatMap((e) => e.files);
    // Deduplicate by path, keeping the latest op
    const fileMap = new Map<string, DeltaDiffFile>();
    for (const f of allFiles) {
        fileMap.set(f.path, f);
    }
    const uniqueFiles = [...fileMap.values()];

    const totalAdded = uniqueFiles.reduce((s, f) => s + (f.added || 0), 0);
    const totalRemoved = uniqueFiles.reduce((s, f) => s + (f.removed || 0), 0);
    const fileCount = uniqueFiles.length;

    return <FileDiffSummaryContent files={uniqueFiles} totalAdded={totalAdded} totalRemoved={totalRemoved} fileCount={fileCount} />;
}

/** Renders a specific DeltaDiffEntry as an inline file change summary. */
export function FileDiffEntryCard({ entry }: { entry: DeltaDiffEntry }) {
    if (!entry?.files?.length) return null;
    const totalAdded = entry.files.reduce((s, f) => s + (f.added || 0), 0);
    const totalRemoved = entry.files.reduce((s, f) => s + (f.removed || 0), 0);
    return <FileDiffSummaryContent files={entry.files} totalAdded={totalAdded} totalRemoved={totalRemoved} fileCount={entry.files.length} />;
}

function FileDiffSummaryContent({ files, totalAdded, totalRemoved, fileCount }: {
    files: DeltaDiffFile[];
    totalAdded: number;
    totalRemoved: number;
    fileCount: number;
}) {
    const [expanded, setExpanded] = useState(true);

    const handleOpenFile = (path: string) => {
        sendToPlugin('open_file', { path }).catch(() => {
            navigator.clipboard?.writeText(path);
        });
    };

    return (
        <div className="file-diff-summary-card">
            <div
                className="file-diff-summary-header"
                onClick={() => setExpanded((e) => !e)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') setExpanded((e) => !e); }}
            >
                <div className="file-diff-summary-title">
                    <svg className="file-diff-chevron" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }} viewBox="0 0 16 16" width="16" height="16">
                        <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 7.5 6.22 3.78a.75.75 0 010-1.06z" />
                    </svg>
                    <span>代码变更: {fileCount} 个文件</span>
                </div>
                <div className="file-diff-summary-stats">
                    <span className="file-diff-add">+{totalAdded}</span>
                    <span className="file-diff-del">-{totalRemoved}</span>
                </div>
            </div>
            {expanded && (
                <div className="file-diff-summary-body">
                    {files.map((file) => (
                        <FileRow key={file.path} file={file} onOpen={handleOpenFile} />
                    ))}
                </div>
            )}
        </div>
    );
}
