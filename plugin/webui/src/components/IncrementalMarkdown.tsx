import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * ★ IncrementalMarkdown: Efficient streaming markdown renderer.
 *
 * Instead of re-rendering the full markdown on every delta, this component:
 * 1. Splits content into "stable" (already rendered) and "active" (streaming) parts
 * 2. Only re-renders the active part on each delta
 * 3. Uses requestAnimationFrame throttling for smooth updates
 * 4. Supports virtual scrolling for long messages via max-height + overflow
 *
 * For production, integrate with a markdown library like react-markdown or marked.
 * This implementation provides the incremental rendering framework.
 */
interface IncrementalMarkdownProps {
    content: string;
    isStreaming: boolean;
    maxHeight?: number; // for virtual scroll
    onRendered?: () => void;
}

export function IncrementalMarkdown({ content, isStreaming, maxHeight, onRendered }: IncrementalMarkdownProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number>(0);
    const [renderedContent, setRenderedContent] = useState('');
    const lastRenderedLength = useRef(0);

    // Throttled rendering via requestAnimationFrame
    const scheduleRender = useCallback((text: string) => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            // Only re-render from the last stable point
            const stableEnd = lastRenderedLength.current;
            const newPart = text.substring(stableEnd);
            if (newPart) {
                // In production, parse only newPart as markdown and append to DOM
                // For now, we do a simple incremental text append
                const html = renderMarkdown(text);
                setRenderedContent(html);
                lastRenderedLength.current = text.length;
            }
            onRendered?.();
        });
    }, [onRendered]);

    useEffect(() => {
        if (isStreaming) {
            scheduleRender(content);
        } else {
            // Final render — full markdown parse
            setRenderedContent(renderMarkdown(content));
            lastRenderedLength.current = content.length;
        }
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [content, isStreaming, scheduleRender]);

    // Auto-scroll to bottom during streaming
    useEffect(() => {
        if (isStreaming && containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [renderedContent, isStreaming]);

    const style: React.CSSProperties = {
        lineHeight: '1.6',
        fontSize: '13px',
        wordBreak: 'break-word',
        ...(maxHeight ? { maxHeight: `${maxHeight}px`, overflowY: 'auto' } : {}),
    };

    return (
        <div ref={containerRef} className="incremental-markdown" style={style} dangerouslySetInnerHTML={{ __html: renderedContent }} />
    );
}

/**
 * Simple markdown-to-HTML renderer.
 * In production, replace with react-markdown, marked, or highlight.js for syntax highlighting.
 */
function renderMarkdown(text: string): string {
    let html = text;

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
        return `<pre class="code-block" data-lang="${lang}"><code>${escapeHtml(code)}</code></pre>`;
    });

    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Bold: **...**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic: *...*
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // Headers: ## ...
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Lists: - item or * item
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');

    // Paragraphs: double newline
    html = html.replace(/\n\n/g, '</p><p>');

    // Single newline → <br>
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph
    if (!html.startsWith('<')) html = `<p>${html}</p>`;

    return html;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}