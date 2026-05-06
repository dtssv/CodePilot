import { html as diff2Html } from 'diff2html';
import { useMemo } from 'react';

interface DiffCardProps {
    path: string;
    hunks: string;
}

export function DiffCard({ path, hunks }: DiffCardProps) {
    const diffHtml = useMemo(
        () =>
            diff2Html(hunks, {
                drawFileList: false,
                matching: 'lines',
                outputFormat: 'side-by-side',
            }),
        [hunks],
    );

    return (
        <div className="diff-card">
            <div className="diff-card-header">
                <span className="diff-card-path">{path}</span>
            </div>
            <div
                className="diff-card-content"
                dangerouslySetInnerHTML={{ __html: diffHtml }}
            />
        </div>
    );
}