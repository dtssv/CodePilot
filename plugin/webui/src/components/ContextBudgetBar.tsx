import React, { useState } from 'react';

interface ContextBudgetBarProps {
  currentTokens: number;
  totalTokens: number;
  estimatedTokens: number;
  onCompress?: () => void;
}

const ContextBudgetBar: React.FC<ContextBudgetBarProps> = ({
  currentTokens,
  totalTokens,
  estimatedTokens,
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
        <div 
          className="budget-progress-fill" 
          style={{ width: `${percentage}%`, backgroundColor: getBarColor() }}
        />
      </div>

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