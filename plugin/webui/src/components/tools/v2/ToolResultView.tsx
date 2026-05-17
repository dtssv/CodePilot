import { sendToPlugin } from '../../../bridge';
import type { ToolResultPayload } from './types';

/**
 * Dispatch on `payload.kind` to a specialized renderer. New kinds added in
 * Kotlin `ToolResultClassifier` must also get a branch here — otherwise they
 * fall through to a JSON dump.
 */
export function ToolResultView({ payload, ok }: { payload: ToolResultPayload | undefined; ok: boolean }) {
    if (!ok || !payload) {
        const err = payload as { kind?: string; errorMessage?: string; errorCode?: string | null; raw?: unknown } | undefined;
        return (
            <div className="tool-result-error">
                <div className="error-title">
                    Error{err?.errorCode ? ` · ${err.errorCode}` : ''}
                </div>
                <pre className="error-message">{err?.errorMessage ?? 'Tool execution failed'}</pre>
                {err?.raw != null && (
                    <details>
                        <summary>raw</summary>
                        <pre className="tool-result-raw">{safeJson(err.raw)}</pre>
                    </details>
                )}
            </div>
        );
    }

    switch (payload.kind) {
        case 'fs.read':         return <FsReadResult p={payload} />;
        case 'fs.list':         return <FsListResult p={payload} />;
        case 'fs.write':        return <FsWriteResult p={payload} />;
        case 'grep':            return <GrepResult p={payload} />;
        case 'shell':           return <ShellResult p={payload} />;
        case 'ide.openFile':    return <IdeOpenFileResult p={payload} />;
        case 'ide.diagnostics': return <IdeDiagnosticsResult p={payload} />;
        case 'ide.shadowValidate': return <ShadowValidateResult p={payload} />;
        case 'mcp':             return <McpResult p={payload} />;
        case 'notepad':         return <NotepadResult p={payload} />;
        case 'code.outline':
        case 'unknown':
        default:                return <UnknownResult raw={(payload as { raw?: unknown }).raw ?? payload} />;
    }
}

// ───── individual renderers ─────

function FsReadResult({ p }: { p: Extract<ToolResultPayload, { kind: 'fs.read' }> }) {
    const rangeText = p.range?.startLine
        ? `:${p.range.startLine}-${p.range.endLine ?? ''}`
        : '';
    return (
        <div className="fs-read-result">
            <div className="fs-read-header">
                <button
                    type="button"
                    className="path-link"
                    onClick={() => openFile(p.path, p.range?.startLine ?? 1)}
                >
                    {p.path}{rangeText}
                </button>
                <span className="muted">
                    {p.totalLines != null ? `${p.totalLines} lines` : ''}
                    {p.bytes != null ? ` · ${formatBytes(p.bytes)}` : ''}
                    {p.lang ? ` · ${p.lang}` : ''}
                    {p.truncated ? ' · truncated' : ''}
                </span>
            </div>
            <pre className="fs-read-content">{p.content}</pre>
        </div>
    );
}

function FsListResult({ p }: { p: Extract<ToolResultPayload, { kind: 'fs.list' }> }) {
    return (
        <div className="fs-list-result">
            <div className="fs-read-header">
                <span className="path-link">{p.path}/</span>
                <span className="muted">{p.entries.length} entries</span>
            </div>
            <ul className="fs-list-entries">
                {p.entries.slice(0, 200).map((e) => (
                    <li key={`${e.type}-${e.name}`} className={`fs-list-${e.type}`}>
                        <span className="fs-list-icon">{e.type === 'dir' ? '📁' : '📄'}</span>
                        <span className="fs-list-name">{e.name}{e.type === 'dir' ? '/' : ''}</span>
                        {e.size != null && <span className="muted">{formatBytes(e.size)}</span>}
                    </li>
                ))}
                {p.entries.length > 200 && (
                    <li className="muted">… and {p.entries.length - 200} more</li>
                )}
            </ul>
        </div>
    );
}

function FsWriteResult({ p }: { p: Extract<ToolResultPayload, { kind: 'fs.write' }> }) {
    return (
        <div className="fs-write-result">
            <div className="fs-write-header">
                <span className={`fs-write-op op-${p.op}`}>{p.op}</span>
                <button
                    type="button"
                    className="path-link"
                    onClick={() => openFile(p.path, 1)}
                >
                    {p.path}
                </button>
            </div>
            {p.appliedVia && <div className="muted">applied via {p.appliedVia}</div>}
        </div>
    );
}

function GrepResult({ p }: { p: Extract<ToolResultPayload, { kind: 'grep' }> }) {
    return (
        <div className="grep-result">
            <div className="grep-summary">
                <code>{p.pattern}</code>
                <span className="muted">
                    {p.total} match{p.total === 1 ? '' : 'es'}{p.truncated ? ' (truncated)' : ''}
                </span>
            </div>
            <ul className="grep-hits">
                {p.matches.slice(0, 200).map((m, i) => (
                    <li key={`${m.path}-${m.line}-${i}`}>
                        <button
                            type="button"
                            className="path-link"
                            onClick={() => openFile(m.path, m.line)}
                        >
                            {m.path}:{m.line}
                        </button>
                        <code className="grep-hit-preview">{m.preview}</code>
                    </li>
                ))}
                {p.matches.length > 200 && (
                    <li className="muted">… and {p.matches.length - 200} more</li>
                )}
            </ul>
        </div>
    );
}

function ShellResult({ p }: { p: Extract<ToolResultPayload, { kind: 'shell' }> }) {
    const exitClass = p.exitCode === 0 ? 'ok' : 'err';
    return (
        <div className="shell-result">
            <div className="shell-header">
                {p.cwd && <span className="shell-cwd" title={p.cwd}>{p.cwd}</span>}
                <span className={`shell-exit ${exitClass}`}>
                    exit {p.exitCode}{p.timedOut ? ' · timed out' : ''} · {p.durationMs}ms
                </span>
            </div>
            <pre className="shell-cmd">$ {p.command}</pre>
            {p.stdout && <pre className="shell-stdout">{p.stdout}</pre>}
            {p.stderr && <pre className="shell-stderr">{p.stderr}</pre>}
        </div>
    );
}

function IdeOpenFileResult({ p }: { p: Extract<ToolResultPayload, { kind: 'ide.openFile' }> }) {
    return (
        <div className="ide-result">
            Opened <button
                type="button"
                className="path-link"
                onClick={() => openFile(p.path, p.line ?? 1)}
            >{p.path}</button>
            {p.line ? <span className="muted"> · line {p.line}</span> : null}
        </div>
    );
}

function IdeDiagnosticsResult({ p }: { p: Extract<ToolResultPayload, { kind: 'ide.diagnostics' }> }) {
    return (
        <div className="ide-result">
            <div className="muted">{p.diagnostics.length} diagnostic(s) in {p.path}</div>
            <ul className="diagnostics">
                {p.diagnostics.slice(0, 100).map((d, i) => (
                    <li key={i} className={`diag-${d.severity.toLowerCase()}`}>
                        <span className="diag-severity">{d.severity}</span>
                        <button
                            type="button"
                            className="path-link"
                            onClick={() => openFile(p.path, d.line)}
                        >L{d.line}</button>
                        <span>{d.message}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function ShadowValidateResult({ p }: { p: Extract<ToolResultPayload, { kind: 'ide.shadowValidate' }> }) {
    return (
        <div className="ide-result">
            <div className={p.passed ? 'shadow-ok' : 'shadow-err'}>
                {p.passed ? '✓ Shadow validation passed' : `✗ ${p.errors.length} error(s)`}
                <span className="muted"> · {p.durationMs}ms</span>
            </div>
            {!p.passed && (
                <ul className="diagnostics">
                    {p.errors.slice(0, 50).map((e, i) => (
                        <li key={i} className={`diag-${(e.severity || 'error').toLowerCase()}`}>
                            <button
                                type="button"
                                className="path-link"
                                onClick={() => openFile(e.file, e.line)}
                            >{e.file}:{e.line}</button>
                            <span>{e.message}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function McpResult({ p }: { p: Extract<ToolResultPayload, { kind: 'mcp' }> }) {
    return (
        <div className="mcp-result">
            <div className="muted">MCP · {p.server} · {p.tool}</div>
            <pre className="tool-result-raw">{safeJson(p.content)}</pre>
        </div>
    );
}

function NotepadResult({ p }: { p: Extract<ToolResultPayload, { kind: 'notepad' }> }) {
    return (
        <div className="notepad-result">
            <div className="muted">notepad.{p.op}</div>
            <pre className="tool-result-raw">{safeJson(p.content)}</pre>
        </div>
    );
}

function UnknownResult({ raw }: { raw: unknown }) {
    return <pre className="tool-result-raw">{safeJson(raw)}</pre>;
}

// ───── helpers ─────

function openFile(path: string, line: number = 1) {
    // The plugin host dispatches by string; the typed PluginEventType union is
    // for incoming events only, so a plain string is correct here.
    sendToPlugin('ide.openFile', { path, line }).catch(() => undefined);
}

function safeJson(v: unknown): string {
    try {
        const s = JSON.stringify(v, null, 2);
        return s.length > 16000 ? `${s.slice(0, 16000)}\n…[truncated]` : s;
    } catch {
        return String(v);
    }
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
