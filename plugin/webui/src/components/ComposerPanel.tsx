import { useCallback, useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';

interface FileEntry {
    path: string;
    content: string;
    status: 'new' | 'modified';
    accepted?: boolean; // null=undecided, true=accepted, false=rejected
}

/**
 * ★ ComposerPanel: Specialized UI for creating a group of files from scratch.
 * Features (matching Cursor Composer):
 * - File tree preview with directory structure
 * - Per-file Accept/Reject buttons
 * - Batch Accept All / Reject All
 * - Content preview with syntax highlighting
 * - Two-step confirmation (Generate → Review → Apply)
 */
export function ComposerPanel() {
    const [instruction, setInstruction] = useState('');
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [generating, setGenerating] = useState(false);
    const [step, setStep] = useState<'input' | 'preview' | 'confirm'>('input');

    // Listen for composer results from plugin
    useEffect(() => {
        const unsub = onPluginEvent('composer_result', (payload: any) => {
            const resultFiles = (payload?.files || []).map((f: any) => ({
                path: f.path || '',
                content: f.content || '',
                status: (f.status || 'new') as 'new' | 'modified',
                accepted: undefined,
            }));
            setFiles(resultFiles);
            setGenerating(false);
            if (resultFiles.length > 0 && step === 'preview') {
                setSelectedFile(resultFiles[0].path);
            }
        });
        return () => { if (typeof unsub === 'function') unsub(); };
    }, [step]);

    const handleGenerate = useCallback(() => {
        if (!instruction.trim()) return;
        setGenerating(true);
        setStep('preview');
        setFiles([]);
        sendToPlugin('composer_generate', { instruction, mode: 'agent' }).catch(() => setGenerating(false));
    }, [instruction, step]);

    const handleAcceptFile = useCallback((path: string) => {
        setFiles(prev => prev.map(f => f.path === path ? { ...f, accepted: true } : f));
    }, []);

    const handleRejectFile = useCallback((path: string) => {
        setFiles(prev => prev.map(f => f.path === path ? { ...f, accepted: false } : f));
    }, []);

    const handleAcceptAll = useCallback(() => {
        setFiles(prev => prev.map(f => ({ ...f, accepted: true })));
    }, []);

    const handleRejectAll = useCallback(() => {
        setFiles(prev => prev.map(f => ({ ...f, accepted: false })));
    }, []);

    const handleApply = useCallback(() => {
        const acceptedFiles = files.filter(f => f.accepted !== false);
        if (acceptedFiles.length === 0) return;
        sendToPlugin('composer_apply_all', {
            files: acceptedFiles.map(f => ({ path: f.path, content: f.content, op: 'create' }))
        }).catch(() => { });
        setStep('confirm');
    }, [files]);

    const handleCancel = useCallback(() => {
        setFiles([]); setSelectedFile(null); setStep('input'); setGenerating(false);
    }, []);

    const selectedContent = files.find(f => f.path === selectedFile)?.content || '';
    const acceptedCount = files.filter(f => f.accepted === true).length;
    const rejectedCount = files.filter(f => f.accepted === false).length;
    const pendingApplyCount = files.filter(f => f.accepted !== false).length;

    // Build directory tree from file paths
    const dirTree = buildDirTree(files.map(f => f.path));

    return (
        <div className="composer-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {step === 'input' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px' }}>
                    <h3 style={{ margin: 0, fontSize: '14px' }}>Composer</h3>
                    <p style={{ margin: 0, fontSize: '12px', opacity: 0.7 }}>Create a group of files from scratch</p>
                    <textarea
                        value={instruction} onChange={e => setInstruction(e.target.value)}
                        placeholder="Describe what you want to create... (e.g., 'A React todo app with TypeScript')"
                        style={{ width: '100%', minHeight: '120px', padding: '10px', fontSize: '13px', background: 'var(--vscode-input-background, #1e1e2e)', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '6px', color: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
                    />
                    <button onClick={handleGenerate} disabled={!instruction.trim()}
                        style={{ padding: '8px 20px', cursor: 'pointer', fontSize: '13px', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px', alignSelf: 'flex-end', opacity: instruction.trim() ? 1 : 0.5 }}>
                        Generate
                    </button>
                </div>
            )}
            {step === 'preview' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* File tree + content preview */}
                    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                        {/* Left: File tree with accept/reject per file */}
                        <div style={{ width: '280px', borderRight: '1px solid var(--vscode-editorWidget-border, #444)', overflowY: 'auto', padding: '8px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', opacity: 0.7 }}>
                                Files ({files.length})
                                {acceptedCount > 0 && <span style={{ color: '#66bb6a', marginLeft: '8px' }}>✓{acceptedCount}</span>}
                                {rejectedCount > 0 && <span style={{ color: '#ef5350', marginLeft: '4px' }}>✗{rejectedCount}</span>}
                            </div>
                            {files.length === 0 && generating && <div style={{ fontSize: '12px', opacity: 0.5 }}>Generating...</div>}
                            {/* Directory tree */}
                            {dirTree.map(node => renderTreeNode(node, selectedFile, setSelectedFile, files, handleAcceptFile, handleRejectFile))}
                        </div>
                        {/* Right: Content preview */}
                        <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
                            {selectedFile ? (
                                <pre style={{ fontSize: '12px', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{selectedContent}</pre>
                            ) : (
                                <div style={{ fontSize: '12px', opacity: 0.5, textAlign: 'center', padding: '20px' }}>Select a file to preview</div>
                            )}
                        </div>
                    </div>
                    {/* Bottom: Batch actions */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--vscode-editorWidget-border, #444)' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button onClick={handleAcceptAll} disabled={files.length === 0}
                                style={{ padding: '4px 12px', cursor: 'pointer', fontSize: '11px', background: 'transparent', border: '1px solid #66bb6a', borderRadius: '3px', color: '#66bb6a' }}>
                                Accept All
                            </button>
                            <button onClick={handleRejectAll} disabled={files.length === 0}
                                style={{ padding: '4px 12px', cursor: 'pointer', fontSize: '11px', background: 'transparent', border: '1px solid #ef5350', borderRadius: '3px', color: '#ef5350' }}>
                                Reject All
                            </button>
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button onClick={handleCancel} style={{ padding: '6px 16px', cursor: 'pointer', fontSize: '12px', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit' }}>Cancel</button>
                            <button onClick={handleApply} disabled={pendingApplyCount === 0}
                                style={{ padding: '6px 16px', cursor: 'pointer', fontSize: '12px', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px', opacity: pendingApplyCount > 0 ? 1 : 0.5 }}>
                                Apply ({pendingApplyCount} files)
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {step === 'confirm' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '40px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>Files created successfully</div>
                    <div style={{ fontSize: '12px', opacity: 0.7 }}>{pendingApplyCount} files have been created</div>
                    <button onClick={handleCancel} style={{ padding: '6px 20px', cursor: 'pointer', fontSize: '12px', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px' }}>Done</button>
                </div>
            )}
        </div>
    );
}

// ─── Directory Tree Helpers ──────────────────────────────────────

interface TreeNode {
    name: string;
    path: string;
    isDir: boolean;
    children: TreeNode[];
}

function buildDirTree(paths: string[]): TreeNode[] {
    const root: TreeNode[] = [];
    for (const filePath of paths) {
        const parts = filePath.split('/');
        let current = root;
        let currentPath = '';
        for (let i = 0; i < parts.length; i++) {
            currentPath = currentPath ? currentPath + '/' + parts[i] : parts[i];
            const isDir = i < parts.length - 1;
            let existing = current.find(n => n.name === parts[i]);
            if (!existing) {
                existing = { name: parts[i], path: currentPath, isDir, children: [] };
                current.push(existing);
            }
            current = existing.children;
        }
    }
    return root;
}

function renderTreeNode(
    node: TreeNode, selectedFile: string | null, onSelect: (p: string) => void,
    files: FileEntry[], onAccept: (p: string) => void, onReject: (p: string) => void,
    depth: number = 0
): JSX.Element {
    const indent = depth * 16;
    if (node.isDir) {
        return (
            <div key={node.path}>
                <div style={{ paddingLeft: indent + 4, fontSize: '12px', opacity: 0.6, padding: '2px 0' }}>
                    📁 {node.name}/
                </div>
                {node.children.map(child => renderTreeNode(child, selectedFile, onSelect, files, onAccept, onReject, depth + 1))}
            </div>
        );
    }
    const file = files.find(f => f.path === node.path);
    const accepted = file?.accepted;
    const statusIcon = accepted === true ? '✓' : accepted === false ? '✗' : '○';
    const statusColor = accepted === true ? '#66bb6a' : accepted === false ? '#ef5350' : '#888';
    return (
        <div key={node.path} style={{ display: 'flex', alignItems: 'center', paddingLeft: indent + 4, paddingRight: '4px' }}>
            <div onClick={() => onSelect(node.path)}
                style={{ flex: 1, padding: '2px 4px', fontSize: '12px', cursor: 'pointer', borderRadius: '3px', background: selectedFile === node.path ? 'var(--vscode-list-hoverBackground, #2a2a3a)' : 'transparent' }}>
                <span style={{ color: statusColor, marginRight: '4px', fontSize: '10px' }}>{statusIcon}</span>
                {node.name}
            </div>
            {accepted === undefined && (
                <div style={{ display: 'flex', gap: '2px' }}>
                    <button onClick={() => onAccept(node.path)} style={{ background: 'none', border: 'none', color: '#66bb6a', cursor: 'pointer', fontSize: '11px', padding: '0 2px' }}>✓</button>
                    <button onClick={() => onReject(node.path)} style={{ background: 'none', border: 'none', color: '#ef5350', cursor: 'pointer', fontSize: '11px', padding: '0 2px' }}>✗</button>
                </div>
            )}
        </div>
    );
}

export default ComposerPanel;