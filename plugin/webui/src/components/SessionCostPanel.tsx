/**
 * Session Cost Panel — shows cumulative token usage and cost for the session.
 * Renders as a collapsible footer bar similar to Cursor's token counter.
 */

import { useState } from 'react';

export interface SessionCostInfo {
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCostUsd: number;
    modelId?: string;
}

interface SessionCostPanelProps {
    costInfo: SessionCostInfo;
}

export function SessionCostPanel({ costInfo }: SessionCostPanelProps) {
    const [expanded, setExpanded] = useState(false);
    const totalTokens = costInfo.totalInputTokens + costInfo.totalOutputTokens;

    return (
        <div className="session-cost-panel">
            <button
                className="cost-toggle"
                onClick={() => setExpanded(!expanded)}
                title="Session usage statistics"
            >
                <span className="cost-label">Tokens</span>
                <span className="cost-value">{formatTokenCount(totalTokens)}</span>
                {costInfo.estimatedCostUsd > 0 && (
                    <span className="cost-amount">
                        ${costInfo.estimatedCostUsd < 0.01 ? '<0.01' : costInfo.estimatedCostUsd.toFixed(2)}
                    </span>
                )}
                <span className="cost-chevron">{expanded ? '▾' : '▸'}</span>
            </button>

            {expanded && (
                <div className="cost-detail">
                    <div className="cost-row">
                        <span className="cost-key">Messages</span>
                        <span className="cost-val">{costInfo.messageCount}</span>
                    </div>
                    <div className="cost-row">
                        <span className="cost-key">Input tokens</span>
                        <span className="cost-val">{formatTokenCount(costInfo.totalInputTokens)}</span>
                    </div>
                    <div className="cost-row">
                        <span className="cost-key">Output tokens</span>
                        <span className="cost-val">{formatTokenCount(costInfo.totalOutputTokens)}</span>
                    </div>
                    <div className="cost-row">
                        <span className="cost-key">Total tokens</span>
                        <span className="cost-val">{formatTokenCount(totalTokens)}</span>
                    </div>
                    <div className="cost-row total">
                        <span className="cost-key">Est. cost</span>
                        <span className="cost-val">
                            ${costInfo.estimatedCostUsd < 0.01 ? '<0.01' : costInfo.estimatedCostUsd.toFixed(3)}
                        </span>
                    </div>
                    {costInfo.modelId && (
                        <div className="cost-row">
                            <span className="cost-key">Model</span>
                            <span className="cost-val model">{costInfo.modelId.split('/').pop()}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function formatTokenCount(n: number): string {
    if (n < 1000) return n.toString();
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}