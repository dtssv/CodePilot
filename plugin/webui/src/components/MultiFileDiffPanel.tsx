import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';

interface PatchHunk {
    id: string;
    startLine: number;
    endLine: number;
    oldContent: string;
    newContent: string;
    accepted?: boolean; // null = undecided, true = accepted, false = rejected
}

interface FilePatch {
    path: string;
    op: 'create' | 'replace' | 'delete';
    hunks: PatchHunk[];
    linesChanged: number;
    allAccepted: boolean;
    allRejected: boolean;
}

/**
 * Multi-file Diff preview panel (Cursor Composer-like experience).
 * Shows all Agent-produced patches grouped by file, with per-hunk accept/reject.
 *
 * Features:
 * - File list with change summary (lines added/removed)
 * - Expand each file to see inline diff
 * - Per-hunk Accept / Reject buttons
 * - "Accept All" / "Reject All" / "Accept Selected" global actions
 * - Integration with PatchApplier via plugin bridge
 */
export function MultiFileDiffPanel() {
    const [patches, setPatches] = useState<FilePatch[]>([]);
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const unsubs = [
            onPluginEvent('multi_file_patches', (data) => {
                const d = data as { patches: FilePatch[] };
                setPatches(d.patches.map(fp => ({
                    ...fp,
                    hunks: fp.hunks.map(h => ({ ...h, accepted: undefined })),
                    allAccepted: false,
                    allRejected: false,
                })));
                setVisible(true);
                // Auto-expand first file
                if (d.patches.length > 0) {
                    setExpandedFiles(new Set([d.patches[0].path]));
                }
            }),
            onPluginEvent('patches_applied', () => {
                setVisible(false);
                setPatches([]);
            }),
        ];
        return () => unsubs.forEach(u => u());
    }, []);

    if (!visible || patches.length === 0) return null;

    const toggleFile = (path: string) => {
        setExpandedFiles(prev => {
            const next = new Set(prev);
            next.has(path) ? next.delete(path) : next.add(path);
            return next;
        });
    };

    const setHunkDecision = (filePath: string, hunkId: string, accepted: boolean) => {
        setPatches(prev => prev.map(fp => {
            if (fp.path !== filePath) return fp;
            const hunks = fp.hunks.map(h => h.id === hunkId ? { ...h, accepted } : h);
            return {
                ...fp, hunks,
                allAccepted: hunks.every(h => h.accepted === true),
                allRejected: hunks.every(h => h.accepted === false),
            };
        }));
    };

    const setFileDecision = (filePath: string, accepted: boolean) => {
        setPatches(prev => prev.map(fp => {
            if (fp.path !== filePath) return fp;
            return { ...fp, hunks: fp.hunks.map(h => ({ ...h, accepted })), allAccepted: accepted, allRejected: !accepted };
        }));
    };

    const acceptAll = () => {
        sendToPlugin('apply_patches', { patches, mode: 'all' });
    };

    const acceptSelected = () => {
        const selected = patches.map(fp => ({
            ...fp,
            hunks: fp.hunks.filter(h => h.accepted === true),
        })).filter(fp => fp.hunks.length > 0);
        sendToPlugin('apply_patches', { patches: selected, mode: 'selected' });
    };

    const rejectAll = () => {
        setVisible(false);
        setPatches([]);
        sendToPlugin('reject_patches', {});
    };

    const totalHunks = patches.reduce((sum, fp) => sum + fp.hunks.length, 0);
    const acceptedHunks = patches.reduce((sum, fp) => sum + fp.hunks.filter(h => h.accepted === true).length, 0);

    const opColors: Record<string, string> = { create: '#3fb950', replace: '#d29922', delete: '#f85149' };
    const opLabels: Record<string, string> = { create: '新建', replace: '修改', delete: '删除' };

    return (
        <div style={{ borderTop: '1px solid #333', background: 'var(--panel-bg, #1a1b26)', maxHeight: '50vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #333', gap: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '13px', color: '#cdd6f4' }}>代码变更</span>
                <span style={{ fontSize: '11px', color: '#888' }}>{patches.length} 个文件, {totalHunks} 处变更</span>
                <span style={{ flex: 1 }} />
                <button onClick={acceptAll} style={actionBtnStyle('#3fb950')}>全部接受</button>
                <button onClick={acceptSelected} style={actionBtnStyle('#58a6ff')} disabled={acceptedHunks === 0}>
                    接受已选 ({acceptedHunks}/{totalHunks})
                </button>
                <button onClick={rejectAll} style={actionBtnStyle('#f85149')}>全部拒绝</button>
            </div>

            {/* File list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {patches.map(fp => (
                    <div key={fp.path}>
                        {/* File header */}
                        <div
                            onClick={() => toggleFile(fp.path)}
                            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', cursor: 'pointer', background: expandedFiles.has(fp.path) ? '#ffffff06' : 'transparent' }}
                        >
                            <span style={{ fontSize: '10px', color: '#666' }}>{expandedFiles.has(fp.path) ? '▼' : '▶'}</span>
                            <span style={{ fontSize: '11px', padding: '1px 5px', borderRadius: '3px', background: `${opColors[fp.op]}22`, color: opColors[fp.op] }}>
                                {opLabels[fp.op]}
                            </span>
                            <span style={{ fontSize: '12px', color: '#cdd6f4', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {fp.path}
                            </span>
                            <span style={{ fontSize: '11px', color: '#888' }}>±{fp.linesChanged}</span>
                            {/* Quick accept/reject for whole file */}
                            <button onClick={(e) => { e.stopPropagation(); setFileDecision(fp.path, true); }}
                                style={{ ...miniBtn, color: fp.allAccepted ? '#3fb950' : '#666' }}>✓</button>
                            <button onClick={(e) => { e.stopPropagation(); setFileDecision(fp.path, false); }}
                                style={{ ...miniBtn, color: fp.allRejected ? '#f85149' : '#666' }}>✗</button>
                        </div>

                        {/* Hunks (expanded) */}
                        {expandedFiles.has(fp.path) && (
                            <div style={{ padding: '0 12px 8px 28px' }}>
                                {fp.hunks.map(hunk => (
                                    <div key={hunk.id} style={{ margin: '4px 0', borderRadius: '4px', border: '1px solid #333', overflow: 'hidden' }}>
                                        {/* Hunk header */}
                                        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', background: '#1e1e2e', gap: '6px' }}>
                                            <span style={{ fontSize: '11px', color: '#888' }}>L{hunk.startLine}-{hunk.endLine}</span>
                                            <span style={{ flex: 1 }} />
                                            <button onClick={() => setHunkDecision(fp.path, hunk.id, true)}
                                                style={{ ...miniBtn, color: hunk.accepted === true ? '#3fb950' : '#555', fontWeight: hunk.accepted === true ? 700 : 400 }}>接受</button>
                                            <button onClick={() => setHunkDecision(fp.path, hunk.id, false)}
                                                style={{ ...miniBtn, color: hunk.accepted === false ? '#f85149' : '#555', fontWeight: hunk.accepted === false ? 700 : 400 }}>拒绝</button>
                                        </div>
                                        {/* Diff content */}
                                        <pre style={{ margin: 0, padding: '6px 8px', fontSize: '11px', lineHeight: '1.5', overflow: 'auto', maxHeight: '200px', background: '#0d1117' }}>
                                            {hunk.oldContent && hunk.oldContent.split('\n').map((line, i) => (
                                                <div key={`old-${i}`} style={{ background: '#f8514922', color: '#f85149' }}>- {line}</div>
                                            ))}
                                            {hunk.newContent && hunk.newContent.split('\n').map((line, i) => (
                                                <div key={`new-${i}`} style={{ background: '#3fb95022', color: '#3fb950' }}>+ {line}</div>
                                            ))}
                                        </pre>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

const miniBtn: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: '2px 6px', borderRadius: '3px',
};

function actionBtnStyle(color: string): React.CSSProperties {
    return {
        background: `${color}22`, color, border: `1px solid ${color}44`, borderRadius: '4px',
        padding: '3px 10px', cursor: 'pointer', fontSize: '11px', fontWeight: 600,
    };
}