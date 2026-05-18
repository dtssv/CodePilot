import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';
import { ShareViewer } from './ShareViewer';

interface Props {
    sessionId: string;
}

type Format = 'markdown' | 'pr_description' | 'json';

interface ShareResult {
    ok: boolean;
    url?: string;
    shareId?: string;
    expiresAt?: string;
    source?: string;
    backend?: 'db' | 'file';
    fallback?: string;
    error?: string;
}

export function ExportPanel({ sessionId }: Props) {
    const [format, setFormat] = useState<Format>('markdown');
    const [includeTools, setIncludeTools] = useState(true);
    const [preview, setPreview] = useState('');
    const [targetPath, setTargetPath] = useState('');
    const [share, setShare] = useState<ShareResult | null>(null);
    const [sharing, setSharing] = useState(false);
    const [persistBackend, setPersistBackend] = useState<'db' | 'file' | null>(null);

    useEffect(() => {
        const offPreview = onPluginEvent('export.preview.result', (payload) => {
            const data = payload as { ok?: boolean; content?: string; error?: string };
            setPreview(data.ok ? data.content ?? '' : `Export failed: ${data.error ?? 'unknown error'}`);
        });
        const offShare = onPluginEvent('share.create.result', (payload) => {
            const data = payload as ShareResult;
            setSharing(false);
            setShare(data);
            if (data.backend) setPersistBackend(data.backend);
        });
        const offStatus = onPluginEvent('share.status.result', (payload) => {
            const data = payload as { backend?: 'db' | 'file'; configured?: boolean };
            if (data.configured && data.backend) setPersistBackend(data.backend);
        });
        sendToPlugin('share.status.get', {}).catch(() => undefined);
        return () => {
            offPreview();
            offShare();
            offStatus();
        };
    }, []);

    useEffect(() => {
        if (!sessionId) return;
        sendToPlugin('export.preview', { sessionId, format, includeTools }).catch(() => undefined);
    }, [sessionId, format, includeTools]);

    const shareLabel = () => {
        if (!share?.ok) return share?.error ?? '';
        if (share.fallback === 'local-file') return `Local file: ${share.url ?? ''}`;
        return share.url ?? '';
    };

    const copyShare = () => {
        const url = shareLabel();
        if (url && !url.startsWith('Share failed')) {
            navigator.clipboard?.writeText(url).catch(() => undefined);
        }
    };

    const openShare = () => {
        const url = share?.url;
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    };

    return (
        <div className="panel-base export-panel">
            <div className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">📤 Share / Export</h3>
                    <span className="panel-subtitle">
                        Cloud share (remote-first) · local export fallback
                        {persistBackend ? (persistBackend === 'db' ? ' · DB' : ' · file') : ''}
                    </span>
                </div>
                <button type="button" className="panel-btn" onClick={() => sendToPlugin('export.preview', { sessionId, format, includeTools })}>Refresh</button>
            </div>
            <div className="panel-section">
                <div className="panel-row">
                    <label className="panel-field">
                        <span className="panel-label">Format</span>
                        <select className="panel-select" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                            <option value="markdown">Markdown</option>
                            <option value="pr_description">PR Description</option>
                            <option value="json">JSON</option>
                        </select>
                    </label>
                    <label className="panel-check-row">
                        <input type="checkbox" checked={includeTools} onChange={(e) => setIncludeTools(e.target.checked)} />
                        Include tool records
                    </label>
                </div>
                <div className="panel-actions">
                    <input className="panel-input" value={targetPath} onChange={(e) => setTargetPath(e.target.value)} placeholder="Target file path" />
                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => sendToPlugin('export.save_file', { sessionId, format, includeTools, path: targetPath })}>Save File</button>
                    <button type="button" className="panel-btn" onClick={() => navigator.clipboard?.writeText(preview)}>Copy</button>
                    <button
                        type="button"
                        className="panel-btn panel-btn-primary"
                        disabled={sharing || !sessionId}
                        onClick={() => {
                            setSharing(true);
                            setShare(null);
                            sendToPlugin('share.create', { sessionId, expireDays: 7 }).catch(() => setSharing(false));
                        }}
                    >
                        {sharing ? 'Creating…' : 'Create Share Link'}
                    </button>
                </div>
            </div>
            {share && (
                <div className={`panel-info share-result ${share.ok ? (share.source === 'cloud' ? 'share-cloud' : 'share-local') : 'share-error'}`}>
                    <strong>
                        {share.ok
                            ? share.source === 'cloud'
                                ? `☁️ Cloud share${share.backend === 'db' ? ' · DB' : ''}`
                                : '📁 Local fallback'
                            : 'Share failed'}
                    </strong>
                    <code className="share-url">{shareLabel()}</code>
                    {share.expiresAt && <span className="share-expires">Expires: {share.expiresAt}</span>}
                    {share.ok && share.url && (
                        <div className="panel-actions share-actions">
                            <button type="button" className="panel-btn" onClick={copyShare}>Copy link</button>
                            {(share.url.startsWith('http://') || share.url.startsWith('https://')) && (
                                <button type="button" className="panel-btn" onClick={openShare}>Open</button>
                            )}
                        </div>
                    )}
                </div>
            )}
            <ShareViewer />
            <pre className="panel-pre">{preview || 'No active session to export.'}</pre>
        </div>
    );
}
