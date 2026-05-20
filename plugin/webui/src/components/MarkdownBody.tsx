import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { normalizeMarkdownForDisplay } from '../utils/markdownNormalize';

const MD_COMPONENTS = {
    p: ({ children }: { children?: ReactNode }) => <p className="md-p">{children}</p>,
    h1: ({ children }: { children?: ReactNode }) => <h1 className="md-h1">{children}</h1>,
    h2: ({ children }: { children?: ReactNode }) => <h2 className="md-h2">{children}</h2>,
    h3: ({ children }: { children?: ReactNode }) => <h3 className="md-h3">{children}</h3>,
    h4: ({ children }: { children?: ReactNode }) => <h4 className="md-h4">{children}</h4>,
    ul: ({ children }: { children?: ReactNode }) => <ul className="md-ul">{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol className="md-ol">{children}</ol>,
    li: ({ children }: { children?: ReactNode }) => <li className="md-li">{children}</li>,
    blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote className="md-blockquote">{children}</blockquote>
    ),
    table: ({ children }: { children?: ReactNode }) => (
        <div className="md-table-wrap">
            <table className="md-table">{children}</table>
        </div>
    ),
    pre: ({ children }: { children?: ReactNode }) => <pre className="md-pre">{children}</pre>,
    code: ({
        className,
        children,
        ...props
    }: {
        className?: string;
        children?: ReactNode;
    }) => {
        const inline = !className;
        if (inline) {
            return (
                <code className="md-code-inline" {...props}>
                    {children}
                </code>
            );
        }
        return (
            <code className={className} {...props}>
                {children}
            </code>
        );
    },
};

/** Normalized GFM markdown with syntax highlighting. */
export function MarkdownBody({
    children,
    className = 'markdown-body agent-content-markdown',
}: {
    children: string;
    className?: string;
}) {
    const normalized = normalizeMarkdownForDisplay(children);
    if (!normalized) return null;
    return (
        <div className={className}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={MD_COMPONENTS}
            >
                {normalized}
            </ReactMarkdown>
        </div>
    );
}
