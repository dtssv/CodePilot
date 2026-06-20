import { sendToPlugin } from '../../bridge';
import { useTranslation } from '../../i18n';
import type { ModelOption, ModelRouteInfo } from '../../state/modelAuthBridge';
import { clearPendingNeedsInput, getPendingNeedsInput, isNeedsInputSubmitted, markNeedsInputSubmitted } from '../../state/needsInputStore';
import type { BranchInfo } from '../../state/sessionUiStore';
import { BranchTreeView } from '../branches/BranchTreeView';
import type { BudgetBreakdown } from '../ContextBudgetBar';
import ContextBudgetBar from '../ContextBudgetBar';
import type { ContextChipData } from '../ContextChip';
import type { ImageData } from '../ImageAttachment';
import { InputBar } from '../InputBar';
import { McpActivityBanner } from '../mcp/McpActivityBanner';
import { ModelSelector } from '../ModelSelector';
import type { SessionCostInfo } from '../SessionCostPanel';
import { SessionCostPanel } from '../SessionCostPanel';
import { ActiveSkillsBar } from '../skills/ActiveSkillsBar';
import { AdmissionWaitBanner } from './AdmissionWaitBanner';
import { MaxModeHint } from './MaxModeHint';
import { RateLimitBanner } from './RateLimitBanner';
import { AgentRoleSelector } from '../AgentRoleSelector';
import type { AgentRole } from '../AgentRoleSelector';

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
    agentRole: AgentRole;
    onAgentRoleChange: (role: AgentRole) => void;
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
    agentRole,
    onAgentRoleChange,
}: ChatInputSectionProps) {
    const { t } = useTranslation();

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
            <ActiveSkillsBar />
            <McpActivityBanner />
            <RateLimitBanner />
            <AdmissionWaitBanner />
            <InputBar
                onSend={(text, chips, images) => {
                    // If there's a pending needs_input, treat user input as needsInput answer
                    const pending = getPendingNeedsInput();
                    if (pending && pending.continuationToken && !isNeedsInputSubmitted(pending.continuationToken)) {
                        markNeedsInputSubmitted(pending.continuationToken);
                        sendToPlugin('needs_input_response', {
                            answers: [{ questionId: '', freeform: text }],
                            continuationToken: pending.continuationToken,
                        });
                        clearPendingNeedsInput();
                        return;
                    }
                    onSend(text, chips, images);
                }}
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
                    <option value="agent">{t('input.modeAgent')}</option>
                    <option value="chat">{t('input.modeChat')}</option>
                </select>
                {mode === 'agent' && (
                    <AgentRoleSelector value={agentRole} onChange={onAgentRoleChange} />
                )}
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
                    <label className="auto-apply-toggle" title={t('input.autoApplyTitle')}>
                        <input
                            type="checkbox"
                            checked={autoApply}
                            onChange={(e) => onAutoApplyChange(e.target.checked)}
                        />
                        <span className="auto-apply-label">{t('input.autoApply')}</span>
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
