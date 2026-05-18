import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { onPluginEvent, sendToPlugin } from '../../bridge';

interface ShareView {
    title: string;
    content: string;
    format: string;
    expiresAt?: string;
    url?: string;
}

export function ShareViewer() {
    const [shareId, setShareId] = useState('');
    const [view, setView] = useState<ShareView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        return onPluginEvent('share.get.result', (payload) => {
            setLoading(false);
            const data = payload as { ok?: boolean; error?: string; expired?: boolean; title?: string; content?: string; format?: string; expiresAt?: string; url?: string };
            if (!data.ok) {
                setView(null);
                setError(data.expired ? 'Share link expired' : (data.error ?? 'Failed to load share'));
                return;
            }
            setError(null);
            setView({
                title: data.title ?? 'Share',
                content: data.content ?? '',
                format: data.format ?? 'markdown',
                expiresAt: data.expiresAt,
                url: data.url,
            });
        });
    }, []);

    const load = () => {
        let id = shareId.trim();
        const slash = id.lastIndexOf('/');
        if (slash >= 0) id = id.substring(slash + 1);
        if (!id) return;
        setLoading(true);
        setError(null);
        sendToPlugin('share.get', { shareId: id }).catch(() => {
            setLoading(false);
            setError('Request failed');
        });
    };

    return (
        <div className="share-viewer panel-section">
            <h4 className="panel-section-title">View shared conversation</h4>
            <div className="panel-row">
                <input
                    className="panel-input"
                    placeholder="Paste share ID or URL suffix (uuid)"
                    value={shareId}
                    onChange={(e) => setShareId(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && load()}
                />
                <button type="button" className="panel-btn" disabled={loading} onClick={load}>
                    {loading ? 'Loading…' : 'Load'}
                </button>
            </div>
            {error && <div className="panel-banner panel-banner-warn" role="alert">{error}</div>}
            {view && (
                <div className="share-viewer-body">
                    <div className="panel-info">
                        <strong>{view.title}</strong>
                        {view.expiresAt && <span className="share-expires">Expires: {view.expiresAt}</span>}
                    </div>
                    {view.format === 'markdown' ? (
                        <div className="share-viewer-markdown markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                {view.content || '(empty)'}
                            </ReactMarkdown>
                        </div>
                    ) : (
                        <pre className="panel-pre share-viewer-content">{view.content || '(empty)'}</pre>
                    )}
                </div>
            )}
        </div>
    );
}
