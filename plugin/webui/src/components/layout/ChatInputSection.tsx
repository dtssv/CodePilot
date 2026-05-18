import { sendToPlugin } from '../../bridge';
import type { BudgetBreakdown } from '../ContextBudgetBar';
import ContextBudgetBar from '../ContextBudgetBar';
import type { ContextChipData } from '../ContextChip';
import { BranchTreeView } from '../branches/BranchTreeView';
import { InputBar } from '../InputBar';
import { ModelSelector } from '../ModelSelector';
import { McpActivityBanner } from '../mcp/McpActivityBanner';
import { MaxModeHint } from './MaxModeHint';
import { NeedsInputDock } from '../NeedsInputDock';
import type { ModelRouteInfo } from '../../state/modelAuthBridge';
import type { SessionCostInfo } from '../SessionCostPanel';
import { SessionCostPanel } from '../SessionCostPanel';
import type { ModelOption } from '../../state/modelAuthBridge';
import type { BranchInfo } from '../../state/sessionUiStore';
import type { ImageData } from '../ImageAttachment';

export interface ChatInputSectionProps {
    contextTokens: number;
    totalTokens: number;
    estimatedTokens: number;
    budgetBreakdown: BudgetBreakdown | null;
    sessionCost: SessionCostInfo;
    contextChips: ContextChipData[];
    mode: 'agent' | 'chat';
    models: ModelOption[];
    selectedModelId: string;
    lastRoute: ModelRouteInfo | null;
    maxMode: boolean;
    autoApply: boolean;
    branches: BranchInfo[];
    activeBranchId: string;
    onSend: (text: string, chips: ContextChipData[], images?: ImageData[]) => void;
    onStop: () => void;
    onRemoveChip: (id: string) => void;
    onPinContext: (chip: ContextChipData) => void;
    onModelSelect: (id: string) => void;
    onModeChange: (mode: 'agent' | 'chat') => void;
    onMaxModeChange: (enabled: boolean) => void;
    onAutoApplyChange: (enabled: boolean) => void;
}

export function ChatInputSection({
    contextTokens,
    totalTokens,
    estimatedTokens,
    budgetBreakdown,
    sessionCost,
    contextChips,
    mode,
    models,
    selectedModelId,
    lastRoute,
    maxMode,
    autoApply,
    branches,
    activeBranchId,
    onSend,
    onStop,
    onRemoveChip,
    onPinContext,
    onModelSelect,
    onModeChange,
    onMaxModeChange,
    onAutoApplyChange,
}: ChatInputSectionProps) {
    return (
        <>
            <ContextBudgetBar
                currentTokens={contextTokens}
                totalTokens={totalTokens}
                estimatedTokens={estimatedTokens}
                breakdown={budgetBreakdown}
                onCompress={() => sendToPlugin('compress_context', {})}
                onRemove={(kind, id) => {
                    if (kind === 'chips') onRemoveChip(id);
                    if (kind === 'history') sendToPlugin('history.remove', { messageId: id });
                    if (kind === 'memories') sendToPlugin('memories.reject', { id });
                }}
            />
            <SessionCostPanel costInfo={sessionCost} />
            <MaxModeHint maxMode={maxMode} lastRoute={lastRoute} />
            <McpActivityBanner />
            <NeedsInputDock />
            <InputBar
                onSend={onSend}
                onStop={onStop}
                contextChips={contextChips}
                onRemoveChip={onRemoveChip}
                onPinContext={onPinContext}
                onModelSelect={onModelSelect}
                sessionCost={sessionCost}
                pendingContextTokens={estimatedTokens}
                contextBudgetTotal={totalTokens}
            />
            <div className="input-bottom-row">
                <select className="opt-select" value={mode} onChange={(e) => onModeChange(e.target.value as 'agent' | 'chat')}>
                    <option value="agent">Agent</option>
                    <option value="chat">Chat</option>
                </select>
                <ModelSelector
                    models={models}
                    selectedModelId={selectedModelId}
                    onSelect={onModelSelect}
                    lastRoute={lastRoute}
                />
                <label className="max-mode-toggle" title="Use the strongest model and larger response budget for this turn">
                    <input type="checkbox" checked={maxMode} onChange={(e) => onMaxModeChange(e.target.checked)} />
                    <span>Max</span>
                </label>
                {mode === 'agent' && (
                    <label className="auto-apply-toggle" title="自动应用低风险文件变更">
                        <input
                            type="checkbox"
                            checked={autoApply}
                            onChange={(e) => onAutoApplyChange(e.target.checked)}
                        />
                        <span className="auto-apply-label">自动写入</span>
                    </label>
                )}
            </div>
            {branches.length > 1 && (
                <BranchTreeView
                    branches={branches.map((b) => ({
                        ...b,
                        title: b.title ?? b.branchId,
                        messageCount: b.messageCount ?? 0,
                        active: b.active ?? b.branchId === activeBranchId,
                    }))}
                />
            )}
        </>
    );
}
