import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { DiffCard } from './DiffCard';
import { NeedsInputCard } from './NeedsInputCard';
import { RiskNoticeCard } from './RiskNoticeCard';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCall?: { id: string; name: string; args: unknown };
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: { question: string; options: string[] };
    diff?: { path: string; hunks: string };
    _streaming?: boolean;
}

interface ChatViewProps {
    messages: ChatMessage[];
}

export function ChatView({ messages }: ChatViewProps) {
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
                <div key={i} className={`msg msg-${msg.role} ${msg._streaming ? 'streaming' : ''}`}>
                    {msg.riskNotice ? (
                        <RiskNoticeCard {...msg.riskNotice} />
                    ) : msg.needsInput ? (
                        <NeedsInputCard question={msg.needsInput.question} options={msg.needsInput.options} />
                    ) : msg.diff ? (
                        <DiffCard path={msg.diff.path} hunks={msg.diff.hunks} />
                    ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                            {msg.content}
                        </ReactMarkdown>
                    )}
                </div>
            ))}
        </div>
    );
}