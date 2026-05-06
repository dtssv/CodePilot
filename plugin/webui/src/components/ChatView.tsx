import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { onPluginEvent } from '../bridge';
import { DiffCard } from './DiffCard';
import { NeedsInputCard } from './NeedsInputCard';
import { RiskNoticeCard } from './RiskNoticeCard';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCall?: { id: string; name: string; args: unknown };
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: { question: string; options: string[] };
    diff?: { path: string; hunks: string };
}

export function ChatView() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [streaming, setStreaming] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const unsubs = [
            onPluginEvent('delta', (p) => {
                const { text } = p as { text: string };
                setStreaming((prev) => prev + text);
            }),
            onPluginEvent('done', () => {
                setStreaming((prev) => {
                    if (prev) {
                        setMessages((msgs) => [...msgs, { role: 'assistant', content: prev }]);
                    }
                    return '';
                });
            }),
            onPluginEvent('tool_call', (p) => {
                const tc = p as { id: string; name: string; args: unknown };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: `Tool: ${tc.name}`, toolCall: tc },
                ]);
            }),
            onPluginEvent('risk_notice', (p) => {
                const rn = p as { level: string; message: string; filesPaths: string[] };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: '', riskNotice: rn },
                ]);
            }),
            onPluginEvent('needs_input', (p) => {
                const ni = p as { question: string; options: string[] };
                setMessages((msgs) => [
                    ...msgs,
                    { role: 'system', content: '', needsInput: ni },
                ]);
            }),
        ];
        return () => unsubs.forEach((u) => u());
    }, []);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages, streaming]);

    return (
        <div className="chat-view" ref={scrollRef}>
            {messages.map((msg, i) => (
                <div key={i} className={`msg msg-${msg.role}`}>
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
            {streaming && (
                <div className="msg msg-assistant streaming">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {streaming}
                    </ReactMarkdown>
                </div>
            )}
        </div>
    );
}