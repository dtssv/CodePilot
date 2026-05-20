import type { StepNode } from '../state/events';

/**
 * Chronological display order for turn steps.
 * Uses envelope seq when present (immune to parent/child tree quirks), else startedAt + insertion index.
 */
export function sortStepsChronologically(stepIds: string[], steps: Record<string, StepNode>): StepNode[] {
    const list = stepIds.map((id) => steps[id]).filter((s): s is StepNode => Boolean(s));
    return list.sort((a, b) => compareStepOrder(a, b, stepIds));
}

function compareStepOrder(a: StepNode, b: StepNode, stepIds: string[]): number {
    const oa = a.orderSeq;
    const ob = b.orderSeq;
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    if (oa != null && ob == null) return -1;
    if (oa == null && ob != null) return 1;
    const ta = a.startedAt ?? 0;
    const tb = b.startedAt ?? 0;
    if (ta !== tb) return ta - tb;
    return stepIds.indexOf(a.stepId) - stepIds.indexOf(b.stepId);
}
