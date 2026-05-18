/**
 * Context chips + budget plugin events.
 */

import type { Dispatch, SetStateAction } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
import type { BudgetBreakdown } from '../components/ContextBudgetBar';
import type { ContextChipData } from '../components/ContextChip';

export interface ContextBridgeHandlers {
    setContextChips: Dispatch<SetStateAction<ContextChipData[]>>;
    setContextTokens: (n: number) => void;
    setTotalTokens: (n: number) => void;
    setEstimatedTokens: (n: number) => void;
    setBudgetBreakdown: (b: BudgetBreakdown | null) => void;
}

export function installContextBridge(handlers: ContextBridgeHandlers): () => void {
    const { setContextChips, setContextTokens, setTotalTokens, setEstimatedTokens, setBudgetBreakdown } = handlers;
    const unsubs = [
        onPluginEvent('context_added', (p) => {
            const data = p as {
                id: string;
                type: 'code' | 'file' | 'package';
                display: string;
                filePath: string;
                language: string;
                startLine: number | null;
                endLine: number | null;
            };
            const chip: ContextChipData = {
                id: data.id,
                type: data.type,
                display: data.display,
                filePath: data.filePath,
                language: data.language,
                startLine: data.startLine,
                endLine: data.endLine,
            };
            setContextChips((prev) => [...prev, chip]);
        }),
        onPluginEvent('context_budget', (p) => {
            const data = p as { current: number; total: number; estimated: number; breakdown?: BudgetBreakdown };
            setContextTokens(data.current);
            setTotalTokens(data.total);
            setEstimatedTokens(data.estimated);
            setBudgetBreakdown(data.breakdown ?? null);
        }),
    ];
    return () => unsubs.forEach((u) => u());
}

/** Ask plugin to estimate token impact of pending @ refs (before send). */
export function requestContextEstimate(chips: ContextChipData[]) {
    const contextRefs = chips.map((chip) => ({
        id: chip.id,
        display: chip.display,
        type: chip.type,
        filePath: chip.filePath,
        language: chip.language,
        startLine: chip.startLine,
        endLine: chip.endLine,
    }));
    sendToPlugin('context.estimate', { contextRefs }).catch(() => undefined);
}
