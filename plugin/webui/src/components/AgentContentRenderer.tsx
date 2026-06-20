import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownBody } from './MarkdownBody';
import { normalizeAgentContentText, normalizeMarkdownForDisplay } from '../utils/graphMarkers';

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
    // <plan>, <file path="...">, <filepath="..."> (LLM typo), <run>
    const tagRegex = /<(plan|file(?:path)?|run)(\s[^>]*)?>([\s\S]*?)<\/(?:plan|file(?:path)?|run)>/gi;
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

        const rawTag = match[1].toLowerCase();
        const tagName = rawTag.startsWith('file') ? 'file' : rawTag;
        const attrStr = match[2] || '';
        const innerContent = match[3];

        if (tagName === 'plan') {
            segments.push({ type: 'plan', content: innerContent.trim() });
        } else if (tagName === 'file') {
            const attrs = parseAttrs(attrStr);
            if (!attrs.path) {
                const pathMatch = attrStr.match(/(?:path|filepath)\s*=\s*"([^"]*)"/i);
                if (pathMatch) attrs.path = pathMatch[1];
            }
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
            parseLooseFileBlocks(segments, remaining);
        }
    }

    if (segments.length === 0 && text.trim()) {
        parseLooseFileBlocks(segments, text);
    }

    return segments;
}

/** Parse <file path="..."> blocks without a closing tag (streaming / LLM typo). */
function parseLooseFileBlocks(segments: ParsedSegment[], text: string) {
    const headerRe = /<(file|filepath)(\s[^>]*)>/gi;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = headerRe.exec(text)) !== null) {
        found = true;
        if (match.index > lastIndex) {
            addMarkdownOrJson(segments, text.slice(lastIndex, match.index));
        }
        const attrStr = match[2] || '';
        const start = match.index + match[0].length;
        const rest = text.slice(start);
        const closeMatch = rest.match(/^([\s\S]*?)<\/(?:file|filepath)>/i);
        const inner = closeMatch ? closeMatch[1] : rest;
        const attrs = parseAttrs(attrStr);
        if (!attrs.path) {
            const pathMatch = attrStr.match(/(?:path|filepath)\s*=\s*"([^"]*)"/i);
            if (pathMatch) attrs.path = pathMatch[1];
        }
        if (attrs.path) {
            segments.push({ type: 'file', content: inner.trim(), attrs });
        }
        lastIndex = closeMatch ? start + closeMatch[0].length : text.length;
    }
    if (!found) {
        addMarkdownOrJson(segments, text);
    } else if (lastIndex < text.length) {
        const tail = text.slice(lastIndex).trim();
        if (tail) addMarkdownOrJson(segments, tail);
    }
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
    // Extract search/replace attributes if present (from <file path="..." search="..." replace="...">)
    const search = attrs?.search || '';
    const replace = attrs?.replace || '';

    const opLabel = op === 'create' ? '新建' : op === 'delete' ? '删除' : op === 'replace' ? '修改' : '写入';
    const opIcon = op === 'create' ? '✨' : op === 'delete' ? '🗑️' : '📝';

    // Build diff lines based on op type
    const diffLines: { type: 'add' | 'remove'; content: string }[] = [];
    if (op === 'delete') {
        diffLines.push({ type: 'remove', content: '// 文件已删除' });
    } else if (op === 'replace' && search) {
        for (const line of search.split('\n')) {
            diffLines.push({ type: 'remove', content: line });
        }
        const newContent = replace || content;
        for (const line of newContent.split('\n')) {
            diffLines.push({ type: 'add', content: line });
        }
    } else {
        // create / write: all green
        for (const line of content.split('\n')) {
            diffLines.push({ type: 'add', content: line });
        }
    }

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
            {expanded && diffLines.length > 0 && (
                <div className="tool-call-diff">
                    <table className="tool-call-diff-table">
                        <tbody>
                            {diffLines.map((line, i) => (
                                <tr key={i} className={'tool-call-diff-line tool-call-diff-' + line.type}>
                                    <td className="tool-call-diff-gutter">{line.type === 'add' ? '+' : '-'}</td>
                                    <td className="tool-call-diff-content"><pre>{line.content}</pre></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
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
 * Skips overly large or tool-result JSON to avoid drowning the chat.
 */
function JsonBlock({ content }: { content: string }) {
    const [expanded, setExpanded] = useState(false);

    // Skip overly large JSON blobs — they belong in tool call cards, not inline
    if (content.length > 2000) {
        try {
            const parsed = JSON.parse(content);
            // Extract just a human-readable summary for these big blobs
            if (parsed.agentWriting) {
                return <div className="agent-json-block agent-json-skipped">📝 {String(parsed.agentWriting).substring(0, 200)}</div>;
            }
            if (parsed.agentContent) {
                return <div className="agent-json-block agent-json-skipped">📝 {String(parsed.agentContent).substring(0, 200)}</div>;
            }
            if (parsed.patches) {
                const fileNames = (parsed.patches as { path?: string }[]).map((p: { path?: string }) => p.path || '').filter(Boolean).join(', ');
                return <div className="agent-json-block agent-json-skipped">📝 写入文件: {fileNames}</div>;
            }
        } catch {
            // fall through to display
        }
    }

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
    /** Hide <file> preview blocks when canonical patch list is shown in writing step. */
    suppressFileBlocks?: boolean;
}

/** If the buffer is a graph JSON envelope, extract user-facing agentContent/textOutput. */
function normalizeGraphEnvelope(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return text;
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.agentContent === 'string' && parsed.agentContent.trim()) {
            return parsed.agentContent;
        }
        if (typeof parsed.textOutput === 'string' && parsed.textOutput.trim()) {
            return parsed.textOutput;
        }
    } catch {
        // keep original
    }
    return text;
}

export function AgentContentRenderer({ content, isStreaming, suppressFileBlocks }: AgentContentRendererProps) {
    if (!content) return null;

    const stripped = normalizeAgentContentText(content);
    if (!stripped) return null;

    const normalized = normalizeMarkdownForDisplay(
        isStreaming ? stripped : normalizeGraphEnvelope(stripped),
    );
    let segments = parseAgentContent(normalized);
    if (suppressFileBlocks) {
        segments = segments.filter((s) => s.type !== 'file');
    }

    // If no structured tags found, render as regular Markdown (hide raw JSON while streaming)
    if (segments.length === 1 && segments[0].type === 'markdown') {
        const md = segments[0].content;
        if (isStreaming && md.trim().startsWith('{')) {
            return <div className="agent-content-streaming agent-content-pending">正在生成回复…</div>;
        }
        return isStreaming ? (
            <div className="agent-content-streaming">
                <MarkdownBody className="markdown-body agent-content-markdown">{md}</MarkdownBody>
            </div>
        ) : (
            <MarkdownBody className="markdown-body agent-content-markdown">{md}</MarkdownBody>
        );
    }

    // Deduplicate plan segments: if multiple <plan> tags exist, merge into one
    // to avoid showing repeated "💡 设计思路" blocks in the chat.
    const planSegments = segments.filter((s) => s.type === 'plan');
    const nonPlanSegments = segments.filter((s) => s.type !== 'plan');
    const mergedPlanContent = planSegments.map((s) => s.content).join('\n\n');
    const hasMergedPlan = planSegments.length > 0;

    return (
        <div className="agent-content">
            {nonPlanSegments.map((seg, idx) => {
                switch (seg.type) {
                    case 'markdown':
                        return <MarkdownBody key={`md-${idx}`}>{seg.content}</MarkdownBody>;
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
            {hasMergedPlan && (
                <details className="agent-plan-block" open>
                    <summary className="agent-plan-header">💡 设计思路</summary>
                    <div className="agent-plan-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{mergedPlanContent}</ReactMarkdown>
                    </div>
                </details>
            )}
        </div>
    );
}