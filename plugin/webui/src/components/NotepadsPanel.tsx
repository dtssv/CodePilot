import { useCallback, useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';

interface NotepadEntry {
    id: string;
    title: string;
    content: string;
    autoPin: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * NotepadsPanel: Context engineering notepads for persistent context.
 * Features:
 * - List all notepads (fetched from plugin via notepad_list)
 * - Create / Edit / Delete notepads
 * - auto-pin toggle
 * - @notepad reference button to insert into chat
 */
export function NotepadsPanel() {
    const [notepads, setNotepads] = useState<NotepadEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editContent, setEditContent] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newContent, setNewContent] = useState('');

    // Fetch notepad list from plugin
    useEffect(() => {
        sendToPlugin('notepad_list', {}).catch(() => {});
        const unsub = onPluginEvent('notepad_list_result', (payload) => {
            const data = payload as { notepads: NotepadEntry[] };
            setNotepads(data.notepads || []);
            setLoading(false);
        });
        return unsub;
    }, []);

    const handleCreate = useCallback(() => {
        if (!newTitle.trim()) return;
        sendToPlugin('notepad_create', { title: newTitle, content: newContent }).then(() => {
            setNotepads(prev => [...prev, {
                id: `notepad_${Date.now()}`,
                title: newTitle,
                content: newContent,
                autoPin: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }]);
            setNewTitle('');
            setNewContent('');
            setShowCreate(false);
        });
    }, [newTitle, newContent]);

    const handleEdit = useCallback((notepad: NotepadEntry) => {
        setEditingId(notepad.id);
        setEditTitle(notepad.title);
        setEditContent(notepad.content);
    }, []);

    const handleSave = useCallback(() => {
        if (!editingId) return;
        sendToPlugin('notepad_edit', { id: editingId, title: editTitle, content: editContent }).then(() => {
            setNotepads(prev => prev.map(n =>
                n.id === editingId ? { ...n, title: editTitle, content: editContent, updatedAt: new Date().toISOString() } : n
            ));
            setEditingId(null);
            setEditTitle('');
            setEditContent('');
        });
    }, [editingId, editTitle, editContent]);

    const handleDelete = useCallback((id: string) => {
        sendToPlugin('notepad_delete', { id }).then(() => {
            setNotepads(prev => prev.filter(n => n.id !== id));
        });
    }, []);

    const handleToggleAutoPin = useCallback((id: string, autoPin: boolean) => {
        sendToPlugin('notepad_edit', { id, autoPin }).then(() => {
            setNotepads(prev => prev.map(n =>
                n.id === id ? { ...n, autoPin } : n
            ));
        });
    }, []);

    const handleReference = useCallback((notepad: NotepadEntry) => {
        // Insert @notepad reference into chat input
        sendToPlugin('notepad_reference', { id: notepad.id, title: notepad.title });
    }, []);

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '14px' }}>Notepads</h3>
                <button
                    onClick={() => setShowCreate(!showCreate)}
                    style={{ fontSize: '12px', padding: '4px 8px', cursor: 'pointer', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px' }}
                >
                    + 新建
                </button>
            </div>

            {/* Create form */}
            {showCreate && (
                <div style={{ padding: '8px', borderRadius: '6px', border: '1px solid var(--vscode-editorWidget-border, #444)', background: 'var(--vscode-editor-background, #1a1a2e)' }}>
                    <input
                        type="text"
                        placeholder="笔记本标题"
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        style={{ width: '100%', padding: '4px 8px', fontSize: '12px', marginBottom: '6px', background: 'var(--vscode-input-background, #1e1e2e)', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit', boxSizing: 'border-box' }}
                    />
                    <textarea
                        placeholder="笔记本内容..."
                        value={newContent}
                        onChange={e => setNewContent(e.target.value)}
                        rows={4}
                        style={{ width: '100%', padding: '4px 8px', fontSize: '12px', marginBottom: '6px', background: 'var(--vscode-input-background, #1e1e2e)', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit', boxSizing: 'border-box', resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={handleCreate} style={{ fontSize: '11px', padding: '3px 10px', cursor: 'pointer', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px' }}>创建</button>
                        <button onClick={() => setShowCreate(false)} style={{ fontSize: '11px', padding: '3px 10px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit' }}>取消</button>
                    </div>
                </div>
            )}

            {/* Notepad list */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {loading && <div style={{ opacity: 0.5, fontSize: '12px', textAlign: 'center', padding: '20px' }}>Loading...</div>}
                {!loading && notepads.length === 0 && (
                    <div style={{ opacity: 0.5, fontSize: '12px', textAlign: 'center', padding: '20px' }}>暂无笔记本，点击新建创建</div>
                )}
                {notepads.map(notepad => (
                    <div key={notepad.id} style={{
                        padding: '10px 12px', borderRadius: '6px',
                        background: 'var(--vscode-editor-background, #1a1a2e)',
                        border: editingId === notepad.id ? '1px solid var(--vscode-button-background, #0078d4)' : '1px solid var(--vscode-editorWidget-border, #444)',
                    }}>
                        {editingId === notepad.id ? (
                            /* Edit mode */
                            <div>
                                <input
                                    type="text"
                                    value={editTitle}
                                    onChange={e => setEditTitle(e.target.value)}
                                    style={{ width: '100%', padding: '4px 8px', fontSize: '12px', marginBottom: '6px', background: 'var(--vscode-input-background, #1e1e2e)', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit', boxSizing: 'border-box' }}
                                />
                                <textarea
                                    value={editContent}
                                    onChange={e => setEditContent(e.target.value)}
                                    rows={4}
                                    style={{ width: '100%', padding: '4px 8px', fontSize: '12px', marginBottom: '6px', background: 'var(--vscode-input-background, #1e1e2e)', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit', boxSizing: 'border-box', resize: 'vertical' }}
                                />
                                <div style={{ display: 'flex', gap: '6px' }}>
                                    <button onClick={handleSave} style={{ fontSize: '11px', padding: '3px 10px', cursor: 'pointer', background: 'var(--vscode-button-background, #0078d4)', border: 'none', color: '#fff', borderRadius: '4px' }}>保存</button>
                                    <button onClick={() => setEditingId(null)} style={{ fontSize: '11px', padding: '3px 10px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit' }}>取消</button>
                                </div>
                            </div>
                        ) : (
                            /* View mode */
                            <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{notepad.title}</span>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                        <label style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                                            <input type="checkbox" checked={notepad.autoPin} onChange={e => handleToggleAutoPin(notepad.id, e.target.checked)} />
                                            Auto-pin
                                        </label>
                                        <button onClick={() => handleReference(notepad)} style={{ fontSize: '11px', padding: '3px 8px', cursor: 'pointer', background: '#58a6ff22', border: '1px solid #58a6ff44', color: '#58a6ff', borderRadius: '4px' }}>@引用</button>
                                        <button onClick={() => handleEdit(notepad)} style={{ fontSize: '11px', padding: '3px 8px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--vscode-editorWidget-border, #444)', borderRadius: '4px', color: 'inherit' }}>编辑</button>
                                        <button onClick={() => handleDelete(notepad.id)} style={{ fontSize: '11px', padding: '3px 8px', cursor: 'pointer', background: 'transparent', border: '1px solid #c62828', color: '#ef5350', borderRadius: '4px' }}>删除</button>
                                    </div>
                                </div>
                                <div style={{ fontSize: '12px', opacity: 0.7, marginTop: '4px', maxHeight: '60px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'pre-wrap' }}>
                                    {notepad.content}
                                </div>
                                <div style={{ fontSize: '10px', opacity: 0.4, marginTop: '4px' }}>
                                    更新于 {new Date(notepad.updatedAt).toLocaleString()}
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}