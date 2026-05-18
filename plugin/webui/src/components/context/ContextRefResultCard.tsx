import type { ContextChipData } from '../ContextChip';

export interface ContextRefResult {
    id: string;
    type: string;
    title: string;
    snippet?: string;
    path?: string;
    tokenEstimate?: number;
    pinned?: boolean;
}

export function ContextRefResultCard({
    result,
    onPin,
    onUnpin,
}: {
    result: ContextRefResult;
    onPin?: (r: ContextRefResult) => void;
    onUnpin?: (id: string) => void;
}) {
    return (
        <div className={`context-ref-card context-ref-${result.type}`}>
            <div className="context-ref-card-header">
                <span className="context-ref-type">@{result.type}</span>
                <span className="context-ref-title">{result.title}</span>
                {result.tokenEstimate !== undefined && (
                    <span className="context-ref-tokens muted">~{result.tokenEstimate} tok</span>
                )}
            </div>
            {result.snippet ? <pre className="context-ref-snippet">{result.snippet}</pre> : null}
            <div className="context-ref-actions">
                {result.pinned ? (
                    <button type="button" className="panel-btn" onClick={() => onUnpin?.(result.id)}>Unpin</button>
                ) : (
                    <button type="button" className="panel-btn" onClick={() => onPin?.(result)}>Pin</button>
                )}
            </div>
        </div>
    );
}

export function chipFromResult(r: ContextRefResult): ContextChipData {
    return {
        id: r.id,
        type: r.type as ContextChipData['type'],
        display: r.title,
        filePath: r.path ?? '',
        language: '',
        startLine: null,
        endLine: null,
    };
}
