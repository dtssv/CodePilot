import React, { useState } from 'react';

interface ContextBudgetBarProps {
  currentTokens: number;
  totalTokens: number;
  estimatedTokens: number;
  breakdown?: BudgetBreakdown | null;
  onCompress?: () => void;
  onRemove?: (kind: string, id: string) => void;
}

export interface BudgetBreakdown {
  total: number;
  used: number;
  estimated: number;
  buckets: BudgetBucket[];
}

export interface BudgetBucket {
  kind: string;
  tokens: number;
  items: { id: string; label: string; tokens: number; removable?: boolean }[];
}

const KIND_COLOR: Record<string, string> = {
  system: '#8b949e',
  rules: '#58a6ff',
  memories: '#bc8cff',
  chips: '#3fb950',
  history: '#d29922',
  tools: '#f85149',
};

const ContextBudgetBar: React.FC<ContextBudgetBarProps> = ({
  currentTokens,
  totalTokens,
  estimatedTokens,
  breakdown,
  onRemove,
  onCompress
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const percentage = Math.min((currentTokens / totalTokens) * 100, 100);
  const isWarning = percentage > 80;
  const isCritical = percentage > 95;

  const getBarColor = () => {
    if (isCritical) return '#ff4d4f';
    if (isWarning) return '#faad14';
    return '#52c41a';
  };

  const remaining = Math.max(0, totalTokens - currentTokens);

  return (
    <div className="context-budget-bar">
      <div className="budget-header">
        <div className="budget-label" 
            onMouseEnter={() => setShowTooltip(true)} 
            onMouseLeave={() => setShowTooltip(false)}>
          <span className="budget-title">Context Budget</span>
          <span className="budget-info-icon">ⓘ</span>
          {showTooltip && (
            <div className="budget-tooltip">
              <div><strong>Context Budget Usage</strong></div>
              <div>Current: {currentTokens.toLocaleString()} tokens</div>
              <div>Total: {totalTokens.toLocaleString()} tokens</div>
              <div>Remaining: {remaining.toLocaleString()} tokens</div>
              {estimatedTokens > 0 && (
                <div>Next request est.: {estimatedTokens.toLocaleString()} tokens</div>
              )}
              {isCritical && <div className="budget-critical-text">Consider compressing context or reducing scope</div>}
            </div>
          )}
        </div>
        <div className="budget-numbers">
          {currentTokens.toLocaleString()} / {totalTokens.toLocaleString()} tokens
        </div>
      </div>
      
      <div className="budget-progress-track">
        {breakdown?.buckets?.length ? (
          <>
            {breakdown.buckets.map((bucket) => (
              <div
                key={bucket.kind}
                className="budget-progress-fill budget-segment"
                style={{
                  width: `${Math.min((bucket.tokens / breakdown.total) * 100, 100)}%`,
                  backgroundColor: KIND_COLOR[bucket.kind] ?? getBarColor(),
                }}
                title={`${bucket.kind}: ${bucket.tokens.toLocaleString()} tokens`}
              />
            ))}
            {breakdown.estimated > 0 && (
              <div
                className="budget-progress-fill budget-segment estimated"
                style={{
                  width: `${Math.min((breakdown.estimated / breakdown.total) * 100, 100)}%`,
                  background: 'repeating-linear-gradient(45deg,#666,#666 4px,transparent 4px,transparent 8px)',
                }}
                title={`estimated: ${breakdown.estimated.toLocaleString()} tokens`}
              />
            )}
          </>
        ) : (
          <div
            className="budget-progress-fill"
            style={{ width: `${percentage}%`, backgroundColor: getBarColor() }}
          />
        )}
      </div>

      {breakdown?.buckets?.length ? (
        <details className="budget-breakdown">
          <summary>Breakdown</summary>
          {breakdown.buckets.map((bucket) => (
            <div key={bucket.kind} className="budget-bucket">
              <div className="budget-bucket-header">
                <span className="budget-dot" style={{ background: KIND_COLOR[bucket.kind] ?? '#888' }} />
                <span>{bucket.kind}</span>
                <span>{bucket.tokens.toLocaleString()}</span>
              </div>
              {bucket.items.map((item) => (
                <div key={item.id} className="budget-item">
                  <span title={item.label}>{item.label}</span>
                  <span>{item.tokens.toLocaleString()}</span>
                  {item.removable && onRemove && (
                    <button type="button" onClick={() => onRemove(bucket.kind, item.id)}>Remove</button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </details>
      ) : null}

      {isWarning && onCompress && (
        <div 
          className={`budget-compress-btn ${isCritical ? 'critical' : ''}`}
          onClick={onCompress}
        >
          {isCritical ? '⚠ Compress context now' : 'Compress context'}
        </div>
      )}
    </div>
  );
};

export default ContextBudgetBar;