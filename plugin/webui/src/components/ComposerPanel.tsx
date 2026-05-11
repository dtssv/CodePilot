import { useState, useCallback } from 'react';
import { sendToPlugin } from '../bridge';

interface FileEntry {
    path: string;
    content: string;
    status: 'new' | 'modified';
}

/**
 * ★ ComposerPanel: Specialized UI for creating a group of files from scratch.
 * Left: file tree preview. Right: content preview. Bottom: Generate → Create All.
 */
export function ComposerPanel() {
    const [instruction, setInstruction] = useState('');
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [generating, setGenerating] = useState(false);
    const [step, setStep] = useState<'input' | 'preview' | 'confirm'>('input');

    const handleGenerate = useCallback(() => {
        if (!instruction.trim()) return;
        setGenerating(true);
        setStep('preview');
        sendToPlugin('composer_generate', { instruction, mode: 'agent' }).catch(() => {});
    }, [instruction]);

    const handleCreateAll = useCallback(() => {
        sendToPlugin('composer_apply_all', {
            files: files.map(f => ({ path: f.path, content: f.content, op: 'create' }))
        }).catch(() => {});
        setStep('confirm');
    }, [files]);

    const handleCancel = useCallback(() => {
        setFiles([]); setSelectedFile(null); setStep('input'); setGenerating(false);
    }, []);

    const selectedContent = files.find(f => f.path === selectedFile)?.content || '';

    return (
        <div className="composer-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {step === 'input' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px' }}>
                    <h3 style={{ margin: 0, fontSize: '14px' }}>Composer</h3>
                    <p style={{ margin: 0, fontSize: '12px', opacity: 0.7 }}>Create a group of files from scratch</p>
                    <textarea
                        value={instruction} onChange={e => setInstruction(e.target.value)}
                        placeholder="Describe what you want to create..."
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
                    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                        <div style={{ width: '240px', borderRight: '1px solid var(--vscode-editorWidget-border, #444)', overflowY: 'auto', padding: '8px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', opacity: 0.7 }}>Files to create</div>
                            {files.length === 0 && generating && <div style={{ fontSize: '12px', opacity: 0.5 }}>Generating...</div>}
                            {files.map(f => (
                                <div key={f.path} onClick={() => setSelectedFile(f.path)}
                                    style={{ padding: '4px 8px', fontSize: '12px', cursor: 'pointer', borderRadius: '3px', background: selectedFile === f.path ? 'var(--vscode-list-hoverBackground, #2a2a3a)' : 'transparent', marginBottom: '2px' }}>
                                    <span style={{ color: '#66bb6a', marginRight: '6px' }}>+</span>{f.path}
                                </div>
                            ))}
                        </div>
                        <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
                            {selectedFile ? <pre style={{ fontSize: '12px', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{selectedContent}</pre>
                                : <div style={{ fontSize: '12px', opacity: 0.5, textAlign: 'center', padding: '20px' }}>Select a file to preview</div>}
                        </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '8px 12px', borderTop: '1px solid var(--vscode-editorWidget-border, #444)' }}>
                        <button onClick={handleCancel} style={{ padding: '6px 16px', cursor: 'pointer', fontSize: '12px', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit' }}>Cancel</button>
                        <button onClick={handleCreateAll} disabled={files.length === 0}
                            style={{ padding: '6px 16px', cursor: 'pointer', fontSize: '12px', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px', opacity: files.length > 0 ? 1 : 0.5 }}>
                            Create All ({files.length} files)
                        </button>
                    </div>
                </div>
            )}
            {step === 'confirm' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '40px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>Files created successfully</div>
                    <div style={{ fontSize: '12px', opacity: 0.7 }}>{files.length} files have been created</div>
                    <button onClick={handleCancel} style={{ padding: '6px 20px', cursor: 'pointer', fontSize: '12px', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px' }}>Done</button>
                </div>
            )}
        </div>
    );
}