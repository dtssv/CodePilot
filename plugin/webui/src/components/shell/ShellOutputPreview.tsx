import { useState } from 'react';
import { formatShellOutput, previewShellOutput } from '../../utils/shellOutput';

export function ShellOutputPreview({
    result,
    maxLines = 4,
    className = '',
}: {
    result: Record<string, unknown>;
    maxLines?: number;
    className?: string;
}) {
    const text = formatShellOutput(result);
    if (!text) return null;

    const [expanded, setExpanded] = useState(false);
    const { preview, rest, truncated } = previewShellOutput(text, maxLines);
    const exitCode = result.exitCode;
    const exitClass = exitCode === 0 ? 'ok' : 'err';

    return (
        <div className={`shell-output-preview ${className}`.trim()}>
            {exitCode != null && (
                <div className="shell-output-meta muted">
                    <span className={`shell-exit ${exitClass}`}>exit {String(exitCode)}</span>
                    {result.durationMs != null && <span> · {String(result.durationMs)}ms</span>}
                </div>
            )}
            <pre className="shell-output-preview-text">{expanded || !truncated ? text : preview}</pre>
            {truncated && (
                <button
                    type="button"
                    className="shell-output-expand-btn"
                    onClick={() => setExpanded((v) => !v)}
                >
                    {expanded ? '▾ 收起输出' : `▾ 展开全部 (${rest.split('\n').length + maxLines} 行)`}
                </button>
            )}
        </div>
    );
}
