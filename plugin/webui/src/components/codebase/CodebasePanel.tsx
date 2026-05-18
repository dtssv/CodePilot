import { useEffect, useMemo, useState } from 'react';
import { sendToPlugin } from '../../bridge';
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
} from '../../state/codebase';

export function CodebasePanel() {
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
                    <h3 className="panel-title">📦 Codebase Index</h3>
                    <span className="panel-subtitle">Local TF-IDF index · {status.embeddingModel}</span>
                </div>
                <span className={`panel-badge state-${status.state}`}>{status.state}</span>
            </header>

            <div className="codebase-progress" aria-label={`Index progress ${pct}%`}>
                <div className="codebase-progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="codebase-stats">
                <span>{status.indexedFiles}/{status.totalFiles} files</span>
                <span>{status.failedFiles} failed</span>
                <span>{status.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : 'never indexed'}</span>
            </div>
            {status.error && <div className="codebase-error">{status.error}</div>}

            <div className="panel-actions">
                <button type="button" className="panel-btn" onClick={() => rebuildCodebase()}>Rebuild</button>
                <button type="button" className="panel-btn" onClick={() => pauseCodebase()} disabled={status.state === 'paused'}>Pause</button>
                <button type="button" className="panel-btn" onClick={() => resumeCodebase()} disabled={status.state !== 'paused'}>Resume</button>
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
                    placeholder="@Codebase search query"
                />
                <button type="submit" className="panel-btn panel-btn-primary">Search</button>
            </form>

            {lastSearch && (
                <div className="codebase-results">
                    <div className="codebase-results-head">
                        Searched codebase: {lastSearch.hits.length} hits in {lastSearch.durationMs}ms
                    </div>
                    {lastSearch.hits.map((hit, idx) => <HitView key={`${hit.path}:${hit.startLine}:${idx}`} hit={hit} />)}
                </div>
            )}

            <details className="codebase-ignore panel-card">
                <summary className="panel-card-header">Ignore patterns</summary>
                <div className="panel-form-group">
                    <textarea
                        className="panel-textarea"
                        rows={5}
                        value={ignoreText}
                        onChange={(e) => setIgnoreText(e.target.value)}
                        placeholder="node_modules/**&#10;dist/**"
                    />
                </div>
                <div className="panel-actions">
                    <button
                        type="button"
                        className="panel-btn panel-btn-primary"
                        onClick={() => setCodebaseIgnore(ignoreText.split('\n').map((s) => s.trim()).filter(Boolean))}
                    >
                        Save ignore and rebuild
                    </button>
                </div>
            </details>
        </section>
    );
}

function HitView({ hit }: { hit: CodebaseHit }) {
    const addToChat = () => {
        sendToPlugin('context.add_ref', {
            filePath: hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
        }).catch(() => undefined);
    };

    return (
        <article className="codebase-hit">
            <div className="codebase-hit-meta">
                <code>{hit.path}:{hit.startLine}-{hit.endLine}</code>
                <span>{hit.matchType ?? 'match'} · {hit.score.toFixed(2)}</span>
                <button type="button" className="panel-btn panel-btn-sm" onClick={addToChat}>
                    Add to chat
                </button>
            </div>
            {hit.symbols && hit.symbols.length > 0 && (
                <div className="codebase-symbols">{hit.symbols.slice(0, 5).join(', ')}</div>
            )}
            <pre>{hit.snippet}</pre>
        </article>
    );
}
