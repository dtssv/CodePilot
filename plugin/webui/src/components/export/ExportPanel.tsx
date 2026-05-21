import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../../bridge';
import { t, useTranslation } from '../../i18n';
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
    const { t: tr } = useTranslation();
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
            setPreview(
                data.ok ? data.content ?? '' : t('panels.export.exportFailed', { error: data.error ?? 'unknown' }),
            );
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
        if (share.fallback === 'local-file') return tr('panels.export.localFile', { path: share.url ?? '' });
        return share.url ?? '';
    };

    const copyShare = () => {
        const url = shareLabel();
        if (url) {
            navigator.clipboard?.writeText(url).catch(() => undefined);
        }
    };

    const openShare = () => {
        const url = share?.url;
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    };

    const subtitle =
        tr('panels.export.subtitle') +
        (persistBackend ? (persistBackend === 'db' ? tr('panels.export.subtitleBackendDb') : tr('panels.export.subtitleBackendFile')) : '');

    return (
        <div className="panel-base export-panel">
            <div className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{tr('panels.export.title')}</h3>
                    <span className="panel-subtitle">{subtitle}</span>
                </div>
                <button type="button" className="panel-btn" onClick={() => sendToPlugin('export.preview', { sessionId, format, includeTools })}>
                    {tr('common.refresh')}
                </button>
            </div>
            <div className="panel-section">
                <div className="panel-row">
                    <label className="panel-field">
                        <span className="panel-label">{tr('panels.export.format')}</span>
                        <select className="panel-select" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                            <option value="markdown">{tr('panels.export.formatMarkdown')}</option>
                            <option value="pr_description">{tr('panels.export.formatPr')}</option>
                            <option value="json">{tr('panels.export.formatJson')}</option>
                        </select>
                    </label>
                    <label className="panel-check-row">
                        <input type="checkbox" checked={includeTools} onChange={(e) => setIncludeTools(e.target.checked)} />
                        {tr('panels.export.includeTools')}
                    </label>
                </div>
                <div className="panel-actions">
                    <input
                        className="panel-input"
                        value={targetPath}
                        onChange={(e) => setTargetPath(e.target.value)}
                        placeholder={tr('panels.export.targetPathPlaceholder')}
                    />
                    <button type="button" className="panel-btn panel-btn-primary" onClick={() => sendToPlugin('export.save_file', { sessionId, format, includeTools, path: targetPath })}>
                        {tr('panels.export.saveFile')}
                    </button>
                    <button type="button" className="panel-btn" onClick={() => navigator.clipboard?.writeText(preview)}>
                        {tr('panels.copy')}
                    </button>
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
                        {sharing ? tr('panels.export.creating') : tr('panels.export.createShare')}
                    </button>
                </div>
            </div>
            {share && (
                <div className={`panel-info share-result ${share.ok ? (share.source === 'cloud' ? 'share-cloud' : 'share-local') : 'share-error'}`}>
                    <strong>
                        {share.ok
                            ? share.source === 'cloud'
                                ? `${tr('panels.export.shareCloud')}${share.backend === 'db' ? tr('panels.export.subtitleBackendDb') : ''}`
                                : tr('panels.export.shareLocal')
                            : tr('panels.export.shareFailed')}
                    </strong>
                    <code className="share-url">{shareLabel()}</code>
                    {share.expiresAt && <span className="share-expires">{tr('panels.export.expires', { date: share.expiresAt })}</span>}
                    {share.ok && share.url && (
                        <div className="panel-actions share-actions">
                            <button type="button" className="panel-btn" onClick={copyShare}>
                                {tr('panels.export.copyLink')}
                            </button>
                            {(share.url.startsWith('http://') || share.url.startsWith('https://')) && (
                                <button type="button" className="panel-btn" onClick={openShare}>
                                    {tr('panels.open')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
            <ShareViewer />
            <pre className="panel-pre">{preview || tr('panels.export.noSession')}</pre>
        </div>
    );
}
