import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/**
 * AgentContentRenderer parses text containing XML-like structured tags
 * and renders them with appropriate UI components:
 *
 * - Plain text → rendered as Markdown
 * - <plan>...</plan> → highlighted thinking block
 * - <file path="..." op="..." lines="+N">...</file> → collapsible code block
 * - <run cmd="...">...</run> → collapsible command block
 */

interface ParsedSegment {
    type: 'markdown' | 'plan' | 'file' | 'run' | 'json';
    content: string;
    attrs?: Record<string, string>;
}

function parseAgentContent(text: string): ParsedSegment[] {
    const segments: ParsedSegment[] = [];
    // Regex to match <plan>, <file>, <run> tags
    const tagRegex = /<(plan|file|run)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(text)) !== null) {
        // Add any text before this tag as markdown
        if (match.index > lastIndex) {
            const before = text.slice(lastIndex, match.index);
            if (before.trim()) {
                // Check if the before text contains raw JSON
                addMarkdownOrJson(segments, before);
            }
        }

        const tagName = match[1];
        const attrStr = match[2] || '';
        const innerContent = match[3];

        if (tagName === 'plan') {
            segments.push({ type: 'plan', content: innerContent.trim() });
        } else if (tagName === 'file') {
            const attrs = parseAttrs(attrStr);
            segments.push({ type: 'file', content: innerContent, attrs });
        } else if (tagName === 'run') {
            const attrs = parseAttrs(attrStr);
            segments.push({ type: 'run', content: innerContent, attrs });
        }

        lastIndex = match.index + match[0].length;
    }

    // Remaining text after last tag
    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex);
        if (remaining.trim()) {
            addMarkdownOrJson(segments, remaining);
        }
    }

    return segments;
}

/**
 * Add a text segment as either markdown or JSON.
 * If the text looks like a JSON object (starts with { and ends with }),
 * parse it and add as a json segment for structured display.
 */
function addMarkdownOrJson(segments: ParsedSegment[], text: string) {
    const trimmed = text.trim();
    // Check if this looks like a standalone JSON object
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'object' && parsed !== null) {
                segments.push({ type: 'json', content: trimmed });
                return;
            }
        } catch {
            // Not valid JSON, render as markdown
        }
    }
    segments.push({ type: 'markdown', content: text });
}

function parseAttrs(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(attrStr)) !== null) {
        attrs[m[1]] = m[2];
    }
    return attrs;
}

function fileName(path: string): string {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
}

function FileBlock({ content, attrs }: { content: string; attrs?: Record<string, string> }) {
    const [expanded, setExpanded] = useState(false);
    const path = attrs?.path || '';
    const op = attrs?.op || 'write';
    const lines = attrs?.lines || '';
    const name = fileName(path);

    const opLabel = op === 'create' ? '新建' : op === 'delete' ? '删除' : op === 'replace' ? '修改' : '写入';
    const opIcon = op === 'create' ? '✨' : op === 'delete' ? '🗑️' : '📝';

    return (
        <div className="agent-file-block">
            <div className="agent-file-header" onClick={() => setExpanded(!expanded)}>
                <span className="agent-file-op-icon">{opIcon}</span>
                <span className="agent-file-name">{name}</span>
                <span className="agent-file-op-label">({opLabel})</span>
                {lines && <span className="agent-file-lines">{lines}行</span>}
                {path && <span className="agent-file-path" title={path}>{path}</span>}
                <button className="agent-file-expand-btn">
                    {expanded ? '▾ 收起' : '▸ 展开查看代码'}
                </button>
            </div>
            {expanded && (
                <pre className="agent-file-code"><code>{content}</code></pre>
            )}
        </div>
    );
}

function RunBlock({ content, attrs }: { content: string; attrs?: Record<string, string> }) {
    const [expanded, setExpanded] = useState(false);
    const cmd = attrs?.cmd || '';

    return (
        <div className="agent-run-block">
            <div className="agent-run-header" onClick={() => setExpanded(!expanded)}>
                <span className="agent-run-icon">⌨️</span>
                <span className="agent-run-cmd"><code>{cmd}</code></span>
                <button className="agent-file-expand-btn">
                    {expanded ? '▾ 收起' : '▸ 展开输出'}
                </button>
            </div>
            {expanded && content && (
                <pre className="agent-run-output">{content}</pre>
            )}
        </div>
    );
}

/**
 * JsonBlock renders a raw JSON object as a collapsible block.
 * Extracts key fields for a summary line, with full JSON expandable.
 */
function JsonBlock({ content }: { content: string }) {
    const [expanded, setExpanded] = useState(false);

    // Try to extract a summary from common LLM output fields
    let summary = '';
    try {
        const parsed = JSON.parse(content);
        if (parsed.thought) summary = parsed.thought;
        else if (parsed.agentThinking) summary = parsed.agentThinking;
        else if (parsed.agentContent) summary = String(parsed.agentContent).substring(0, 100);
        else if (parsed.final?.answer) summary = String(parsed.final.answer).substring(0, 100);
        else if (parsed.textOutput) summary = String(parsed.textOutput).substring(0, 100);
        else if (parsed.plan?.goal) summary = parsed.plan.goal;
        else if (parsed.goal) summary = parsed.goal;
    } catch {
        summary = content.substring(0, 80) + '...';
    }

    return (
        <div className="agent-json-block">
            <div className="agent-json-header" onClick={() => setExpanded(!expanded)}>
                <span className="agent-json-icon">📋</span>
                <span className="agent-json-summary">{summary || '结构化数据'}</span>
                <button className="agent-file-expand-btn">
                    {expanded ? '▾ 收起' : '▸ 展开详情'}
                </button>
            </div>
            {expanded && (
                <pre className="agent-json-content">{content}</pre>
            )}
        </div>
    );
}

interface AgentContentRendererProps {
    content: string;
    isStreaming?: boolean;
}

export function AgentContentRenderer({ content, isStreaming }: AgentContentRendererProps) {
    if (!content) return null;

    const segments = parseAgentContent(content);

    // If no structured tags found, render as regular Markdown
    if (segments.length === 1 && segments[0].type === 'markdown') {
        return isStreaming ? (
            <div className="agent-content-streaming">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {segments[0].content}
                </ReactMarkdown>
            </div>
        ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {segments[0].content}
            </ReactMarkdown>
        );
    }

    return (
        <div className="agent-content">
            {segments.map((seg, idx) => {
                switch (seg.type) {
                    case 'markdown':
                        return (
                            <ReactMarkdown key={`md-${idx}`} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                {seg.content}
                            </ReactMarkdown>
                        );
                    case 'plan':
                        return (
                            <div key={`plan-${idx}`} className="agent-plan-block">
                                <div className="agent-plan-header">💡 设计思路</div>
                                <div className="agent-plan-content">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.content}</ReactMarkdown>
                                </div>
                            </div>
                        );
                    case 'file':
                        return <FileBlock key={`file-${idx}`} content={seg.content} attrs={seg.attrs} />;
                    case 'run':
                        return <RunBlock key={`run-${idx}`} content={seg.content} attrs={seg.attrs} />;
                    case 'json':
                        return <JsonBlock key={`json-${idx}`} content={seg.content} />;
                    default:
                        return null;
                }
            })}
        </div>
    );
}