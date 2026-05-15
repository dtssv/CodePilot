import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { AgentContentRenderer } from './AgentContentRenderer';
import { AgentStep, AgentStepCard } from './AgentStepCard';
import { BranchTimeline } from './BranchTimeline';
import { DiffCard } from './DiffCard';
import { IncrementalMarkdown } from './IncrementalMarkdown';
import { NeedsInputCard } from './NeedsInputCard';
import { RiskNoticeCard } from './RiskNoticeCard';
import { ToolCallCard, ToolCallInfo } from './ToolCallCard';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    contextRefs?: { id?: string; display: string; type?: string }[];
    toolCall?: { id: string; name: string; args: unknown };
    /** Tool calls attached to an assistant message (rendered as inline cards) */
    toolCalls?: ToolCallInfo[];
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: { title?: string; questions?: { id: string; prompt: string; kind?: string; options?: { id: string; label: string }[] }[]; continuationToken?: string };
    diff?: { path: string; hunks: string };
    // ★ Integration: Image attachments and branch info
    images?: { url: string; mimeType?: string; description?: string }[];
    branches?: { branchId: string; sessionId: string; forkMsgIndex: number }[];
    /** Agent interactive steps (thinking/reading/writing/running) */
    agentSteps?: AgentStep[];
    /** Plan steps shown in the response (from user_plan event) */
    planSteps?: { id: string; title: string; status: string }[];
    _streaming?: boolean;
    tokenMeta?: {
        inputTokens: number;
        outputTokens: number;
        modelId?: string;
        costUsd?: number;
        latencyMs?: number;
    };
}

interface ChatViewProps {
    messages: ChatMessage[];
    onForkFromMessage?: (messageIndex: number) => void;
}

const refTypeIcons: Record<string, string> = {
    code: '{ }',
    file: '📄',
    package: '📦',
    folder: '📁',
    symbol: '🔤',
    git: '🔀',
    codebase: '🔍',
    docs: '📚',
    web: '🌐',
    terminal: '💻',
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
                <div key={i} className={`msg-row msg-row-${msg.role}`}
                    onMouseEnter={(e) => {
                        const btn = e.currentTarget.querySelector('.msg-fork-btn') as HTMLElement;
                        if (btn) btn.style.opacity = '1';
                    }}
                    onMouseLeave={(e) => {
                        const btn = e.currentTarget.querySelector('.msg-fork-btn') as HTMLElement;
                        if (btn) btn.style.opacity = '0';
                    }}>
                    {msg.role !== 'system' && !(msg.role === 'assistant' && !msg.content && msg.toolCalls && msg.toolCalls.length > 0) && (
                        <div className={`msg-avatar msg-avatar-${msg.role}`}>
                            {msg.role === 'user' ? 'U' : '✦'}
                        </div>
                    )}
                    <div className={`msg msg-${msg.role} ${msg._streaming ? 'streaming' : ''}`}>
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
                        ) : msg.role === 'assistant' ? (
                            // ★ Assistant message: unified rendering pipeline
                            // Priority: content (AgentContentRenderer) > agentSteps (progress) > toolCalls (fallback)
                            // When content exists, agentSteps are hidden to avoid duplicate display
                            <>
                                {/* Plan steps: always show when present (independent of content) */}
                                {msg.planSteps && msg.planSteps.length > 0 && (
                                    <div className="plan-steps-container">
                                        <div className="plan-steps-header">📋 执行计划</div>
                                        {msg.planSteps.map((step, idx) => (
                                            <div key={step.id || idx} className="plan-step-item">
                                                <span className={`plan-step-status plan-step-${step.status}`}>
                                                    {step.status === 'success' || step.status === 'done' ? '✓' : step.status === 'running' || step.status === 'in_progress' ? '◉' : step.status === 'failed' ? '✗' : '○'}
                                                </span>
                                                <span className="plan-step-title">{step.title}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {/* Agent steps: only show as progress indicator when content hasn't arrived yet */}
                                {msg.agentSteps && msg.agentSteps.length > 0 && !msg.content && (
                                    <div className="agent-steps-container">
                                        {msg.agentSteps.map((step, idx) => (
                                            <AgentStepCard key={`step-${idx}`} step={step} />
                                        ))}
                                    </div>
                                )}
                                {/* Content rendering — always takes priority when present */}
                                {msg.content ? (
                                    <AgentContentRenderer content={msg.content} isStreaming={msg._streaming} />
                                ) : null}
                                {/* Tool call cards — fallback when no content and no agentSteps */}
                                {!msg.content && !(msg.agentSteps && msg.agentSteps.length > 0) && msg.toolCalls && msg.toolCalls.length > 0 && (
                                    <div className="msg-tool-calls">
                                        {msg.toolCalls.map((tc) => (
                                            <ToolCallCard key={tc.id} toolCall={tc} />
                                        ))}
                                    </div>
                                )}
                            </>
                        ) : (
                            msg._streaming ? (
                                <IncrementalMarkdown content={msg.content} isStreaming={true} />
                            ) : (
                                msg.content ? (
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                        {msg.content}
                                    </ReactMarkdown>
                                ) : null
                            )
                        )}
                        {/* ★ Image attachments rendering */}
                        {msg.images && msg.images.length > 0 && (
                            <div className="msg-images">
                                {msg.images.map((img, imgIdx) => (
                                    <div key={`img-${i}-${imgIdx}`} className="msg-image-item">
                                        <img
                                            src={img.url}
                                            alt={img.description || `Image ${imgIdx + 1}`}
                                            className="msg-image-preview"
                                            style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '4px', margin: '4px 0' }}
                                        />
                                        {img.description && (
                                            <div className="msg-image-desc" style={{ fontSize: '11px', opacity: 0.6, marginTop: '2px' }}>
                                                {img.description}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* ★ Branch timeline rendering */}
                        {msg.branches && msg.branches.length > 0 && (
                            <BranchTimeline
                                branches={msg.branches.map(b => ({
                                    branchId: b.branchId,
                                    parentBranchId: undefined,
                                    title: `Fork at msg #${b.forkMsgIndex}`,
                                    messageCount: 0,
                                }))}
                                activeBranchId={msg.branches[0]?.branchId || ''}
                                onSwitchBranch={(branchId) => {
                                    const branch = msg.branches?.find(b => b.branchId === branchId);
                                    if (branch) {
                                        // Dispatch branch switch via custom event
                                        window.dispatchEvent(new CustomEvent('codepilot:switch_branch', {
                                            detail: { sessionId: branch.sessionId, branchId }
                                        }));
                                    }
                                }}
                            />
                        )}
                        {onForkFromMessage && !msg._streaming && !(msg.role === 'assistant' && !msg.content && msg.toolCalls && msg.toolCalls.length > 0) && (
                            <button
                                className="msg-fork-btn"
                                title="Fork conversation from this message"
                                onClick={() => onForkFromMessage(i)}
                            >
                                ↗ Fork
                            </button>
                        )}
                        {msg.tokenMeta && !msg._streaming && (
                            <div className="msg-token-meta">
                                {msg.tokenMeta.inputTokens > 0 && (
                                    <span className="token-badge input" title="Input tokens">
                                        ↑{msg.tokenMeta.inputTokens}
                                    </span>
                                )}
                                {msg.tokenMeta.outputTokens > 0 && (
                                    <span className="token-badge output" title="Output tokens">
                                        ↓{msg.tokenMeta.outputTokens}
                                    </span>
                                )}
                                {msg.tokenMeta.latencyMs != null && (
                                    <span className="token-badge latency" title="Latency">
                                        {msg.tokenMeta.latencyMs < 1000
                                            ? `${msg.tokenMeta.latencyMs}ms`
                                            : `${(msg.tokenMeta.latencyMs / 1000).toFixed(1)}s`}
                                    </span>
                                )}
                                {msg.tokenMeta.costUsd != null && msg.tokenMeta.costUsd > 0 && (
                                    <span className="token-badge cost" title="Estimated cost">
                                        ${msg.tokenMeta.costUsd < 0.01 ? '<0.01' : msg.tokenMeta.costUsd.toFixed(3)}
                                    </span>
                                )}
                                {msg.tokenMeta.modelId && (
                                    <span className="token-badge model" title="Model">
                                        {msg.tokenMeta.modelId.split('/').pop()}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}