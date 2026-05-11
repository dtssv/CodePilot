import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { DiffCard } from './DiffCard';
import { IncrementalMarkdown } from './IncrementalMarkdown';
import { NeedsInputCard } from './NeedsInputCard';
import { RiskNoticeCard } from './RiskNoticeCard';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    contextRefs?: { id?: string; display: string; type?: string }[];
    toolCall?: { id: string; name: string; args: unknown };
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: { question: string; options: string[] };
    diff?: { path: string; hunks: string };
    _streaming?: boolean;
}

interface ChatViewProps {
    messages: ChatMessage[];
    onForkFromMessage?: (messageIndex: number) => void;
}

const refTypeIcons: Record<string, string> = {
    code: '{ }',
    file: '📄',
    package: '📦',
};

function parseInlineRefs(content: string, contextRefs?: { id?: string; display: string; type?: string }[]): React.ReactNode[] {
    if (!contextRefs || contextRefs.length === 0) {
        return [content];
    }
    const refMap = new Map<string, { display: string; type?: string }>();
    for (const ref of contextRefs) {
        if (ref.id) refMap.set(ref.id, ref);
    }
    const segments: React.ReactNode[] = [];
    let remaining = content;
    let keyIdx = 0;
    while (remaining.length > 0) {
        const start = remaining.indexOf('\x01');
        if (start < 0) {
            if (remaining) segments.push(remaining);
            break;
        }
        if (start > 0) segments.push(remaining.substring(0, start));
        const end = remaining.indexOf('\x01', start + 1);
        if (end < 0) {
            segments.push(remaining.substring(start));
            break;
        }
        const id = remaining.substring(start + 1, end);
        const ref = refMap.get(id);
        if (ref) {
            segments.push(
                <span key={`r${keyIdx++}`} className={`msg-ref-chip ref-${ref.type || 'code'}`}>
                    <span className="ref-icon">{refTypeIcons[ref.type || 'code'] || '📎'}</span>
                    <span className="ref-label">{ref.display}</span>
                </span>
            );
        }
        remaining = remaining.substring(end + 1);
    }
    return segments;
}

export function ChatView({ messages, onForkFromMessage }: ChatViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages]);

    return (
        <div className="chat-view" ref={scrollRef}>
            {messages.length === 0 && (
                <div className="chat-empty">
                    <div className="chat-empty-icon">✦</div>
                    <div className="chat-empty-title">CodePilot</div>
                    <div className="chat-empty-hint">Ask me anything about your code. I can help with refactoring, debugging, writing tests, and more.</div>
                </div>
            )}
            {messages.map((msg, i) => (
                <div key={i} className={`msg msg-${msg.role} ${msg._streaming ? 'streaming' : ''}`}
                     onMouseEnter={(e) => {
                         const btn = e.currentTarget.querySelector('.msg-fork-btn') as HTMLElement;
                         if (btn) btn.style.opacity = '1';
                     }}
                     onMouseLeave={(e) => {
                         const btn = e.currentTarget.querySelector('.msg-fork-btn') as HTMLElement;
                         if (btn) btn.style.opacity = '0';
                     }}>
                    {msg.riskNotice ? (
                        <RiskNoticeCard {...msg.riskNotice} />
                    ) : msg.needsInput ? (
                        <NeedsInputCard payload={msg.needsInput as any} />
                    ) : msg.diff ? (
                        <DiffCard path={msg.diff.path} hunks={msg.diff.hunks} />
                    ) : msg.role === 'user' && msg.contextRefs && msg.contextRefs.length > 0 ? (
                        <div className="msg-inline-refs">
                            {parseInlineRefs(msg.content, msg.contextRefs).map((seg) => seg)}
                        </div>
                    ) : (
                        msg._streaming ? (
                            <IncrementalMarkdown content={msg.content} isStreaming={true} />
                        ) : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                {msg.content}
                            </ReactMarkdown>
                        )
                    )}
                    {onForkFromMessage && !msg._streaming && (
                        <button
                            className="msg-fork-btn"
                            title="Fork conversation from this message"
                            onClick={() => onForkFromMessage(i)}
                        >
                            ↗ Fork
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}