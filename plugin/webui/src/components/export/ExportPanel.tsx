import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';

interface Props {
    sessionId: string;
}

type Format = 'markdown' | 'pr_description' | 'json';

export function ExportPanel({ sessionId }: Props) {
    const [format, setFormat] = useState<Format>('markdown');
    const [includeTools, setIncludeTools] = useState(true);
    const [preview, setPreview] = useState('');
    const [targetPath, setTargetPath] = useState('');
    const [shareUrl, setShareUrl] = useState('');

    useEffect(() => {
        const offPreview = onPluginEvent('export.preview.result', (payload) => {
            const data = payload as { ok?: boolean; content?: string; error?: string };
            setPreview(data.ok ? data.content ?? '' : `Export failed: ${data.error ?? 'unknown error'}`);
        });
        const offShare = onPluginEvent('share.create.result', (payload) => {
            const data = payload as { ok?: boolean; url?: string; error?: string };
            setShareUrl(data.ok ? data.url ?? '' : `Share failed: ${data.error ?? 'unknown error'}`);
        });
        return () => {
            offPreview();
            offShare();
        };
    }, []);

    useEffect(() => {
        if (!sessionId) return;
        sendToPlugin('export.preview', { sessionId, format, includeTools }).catch(() => undefined);
    }, [sessionId, format, includeTools]);

    return (
        <div className="export-panel">
            <div className="panel-header">
                <h3>Share / Export</h3>
                <button type="button" onClick={() => sendToPlugin('export.preview', { sessionId, format, includeTools })}>Refresh</button>
            </div>
            <div className="export-controls">
                <label>
                    Format
                    <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                        <option value="markdown">Markdown</option>
                        <option value="pr_description">PR Description</option>
                        <option value="json">JSON</option>
                    </select>
                </label>
                <label>
                    <input type="checkbox" checked={includeTools} onChange={(e) => setIncludeTools(e.target.checked)} />
                    Include tool records
                </label>
            </div>
            <div className="export-actions">
                <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} placeholder="Target file path" />
                <button type="button" onClick={() => sendToPlugin('export.save_file', { sessionId, format, includeTools, path: targetPath })}>Save File</button>
                <button type="button" onClick={() => navigator.clipboard?.writeText(preview)}>Copy</button>
                <button type="button" onClick={() => sendToPlugin('share.create', { sessionId })}>Create Local Share</button>
            </div>
            {shareUrl && <div className="share-url"><strong>Share:</strong> <code>{shareUrl}</code></div>}
            <pre className="export-preview">{preview || 'No active session to export.'}</pre>
        </div>
    );
}
