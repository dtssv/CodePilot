import { useEffect, useMemo, useState } from 'react';
import { sendToPlugin } from '../../bridge';
import { useTranslation } from '../../i18n';
import {
    getCodebaseState,
    installCodebaseBridge,
    pauseCodebase,
    rebuildCodebase,
    requestCodebaseStatus,
    resumeCodebase,
    searchCodebase,
    setCodebaseIgnore,
    subscribeCodebase,
    type CodebaseHit,
    type CodebaseSearchResult,
    type CodebaseStatus,
    type CodebaseState,
} from '../../state/codebase';

function stateLabel(t: (k: string) => string, state: CodebaseState): string {
    const key = `panels.codebase.state.${state}`;
    const v = t(key);
    return v === key ? state : v;
}

export function CodebasePanel() {
    const { t } = useTranslation();
    const [status, setStatus] = useState<CodebaseStatus>(getCodebaseState().status);
    const [lastSearch, setLastSearch] = useState<CodebaseSearchResult | undefined>(getCodebaseState().lastSearch);
    const [query, setQuery] = useState('');
    const [ignoreText, setIgnoreText] = useState('');

    useEffect(() => {
        installCodebaseBridge();
        const off = subscribeCodebase((s) => {
            setStatus(s.status);
            setLastSearch(s.lastSearch);
            setIgnoreText((cur) => cur || (s.status.ignored ?? []).join('\n'));
        });
        requestCodebaseStatus().catch(() => undefined);
        return off;
    }, []);

    const pct = useMemo(() => {
        if (!status.totalFiles) return 0;
        return Math.floor((status.indexedFiles / status.totalFiles) * 100);
    }, [status.indexedFiles, status.totalFiles]);

    return (
        <section className="panel-base codebase-panel">
            <header className="panel-header">
                <div className="panel-title-group">
                    <h3 className="panel-title">{t('panels.codebase.title')}</h3>
                    <span className="panel-subtitle">{t('panels.codebase.subtitle', { model: status.embeddingModel })}</span>
                </div>
                <span className={`panel-badge state-${status.state}`}>{stateLabel(t, status.state)}</span>
            </header>

            <div className="codebase-progress" aria-label={t('panels.codebase.progressAria', { pct })}>
                <div className="codebase-progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="codebase-stats">
                <span>{t('panels.codebase.filesIndexed', { indexed: status.indexedFiles, total: status.totalFiles })}</span>
                <span>{t('panels.codebase.failedCount', { n: status.failedFiles })}</span>
                <span>{status.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : t('panels.codebase.neverIndexed')}</span>
            </div>
            {status.error && <div className="codebase-error">{status.error}</div>}

            <div className="panel-actions">
                <button type="button" className="panel-btn" onClick={() => rebuildCodebase()}>
                    {t('panels.codebase.rebuild')}
                </button>
                <button type="button" className="panel-btn" onClick={() => pauseCodebase()} disabled={status.state === 'paused'}>
                    {t('panels.codebase.pause')}
                </button>
                <button type="button" className="panel-btn" onClick={() => resumeCodebase()} disabled={status.state !== 'paused'}>
                    {t('panels.codebase.resume')}
                </button>
            </div>

            <form
                className="panel-search"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (query.trim()) searchCodebase(query.trim(), 12).catch(() => undefined);
                }}
            >
                <input
                    className="panel-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('panels.codebase.searchPlaceholder')}
                />
                <button type="submit" className="panel-btn panel-btn-primary">
                    {t('panels.codebase.search')}
                </button>
            </form>

            {lastSearch && (
                <div className="codebase-results">
                    <div className="codebase-results-head">
                        {t('panels.codebase.resultsSummary', { hits: lastSearch.hits.length, ms: lastSearch.durationMs })}
                    </div>
                    {lastSearch.hits.map((hit, idx) => <HitView key={`${hit.path}:${hit.startLine}:${idx}`} hit={hit} />)}
                </div>
            )}

            <details className="codebase-ignore panel-card">
                <summary className="panel-card-header">{t('panels.codebase.ignoreSummary')}</summary>
                <div className="panel-form-group">
                    <textarea
                        className="panel-textarea"
                        rows={5}
                        value={ignoreText}
                        onChange={(e) => setIgnoreText(e.target.value)}
                        placeholder={t('panels.codebase.ignorePlaceholder')}
                    />
                </div>
                <div className="panel-actions">
                    <button
                        type="button"
                        className="panel-btn panel-btn-primary"
                        onClick={() => setCodebaseIgnore(ignoreText.split('\n').map((s) => s.trim()).filter(Boolean))}
                    >
                        {t('panels.codebase.saveIgnoreRebuild')}
                    </button>
                </div>
            </details>
        </section>
    );
}

function HitView({ hit }: { hit: CodebaseHit }) {
    const { t } = useTranslation();
    const addToChat = () => {
        sendToPlugin('context.add_ref', {
            filePath: hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
        }).catch(() => undefined);
    };
    const matchType = hit.matchType ?? 'match';

    return (
        <article className="codebase-hit">
            <div className="codebase-hit-meta">
                <code>{hit.path}:{hit.startLine}-{hit.endLine}</code>
                <span>{t('panels.codebase.scoreLine', { type: matchType, score: hit.score.toFixed(2) })}</span>
                <button type="button" className="panel-btn panel-btn-sm" onClick={addToChat}>
                    {t('panels.codebase.addToChat')}
                </button>
            </div>
            {hit.symbols && hit.symbols.length > 0 && (
                <div className="codebase-symbols">{hit.symbols.slice(0, 5).join(', ')}</div>
            )}
            <pre>{hit.snippet}</pre>
        </article>
    );
}
