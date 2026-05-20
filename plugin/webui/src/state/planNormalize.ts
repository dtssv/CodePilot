import type { PlanStep } from './events';

/** Map backend / legacy statuses to UI plan step status. */
export function normalizePlanStatus(raw: string | undefined): PlanStep['status'] {
    const s = (raw ?? 'pending').toLowerCase();
    switch (s) {
        case 'in_progress':
        case 'running':
            return 'running';
        case 'completed':
        case 'done':
        case 'success':
            return 'success';
        case 'failed':
        case 'error':
            return 'error';
        case 'skipped':
            return 'skipped';
        default:
            return s === 'pending' ? 'pending' : (s as PlanStep['status']);
    }
}

/** CSS class suffix for legacy plan-step-* styles. */
export function planStatusCssClass(status: string): string {
    const s = normalizePlanStatus(status);
    if (s === 'running') return 'in_progress';
    return s;
}

export function planStatusIcon(status: string): string {
    const s = normalizePlanStatus(status);
    if (s === 'success') return '✓';
    if (s === 'running') return '◉';
    if (s === 'error') return '✗';
    if (s === 'skipped') return '—';
    return '○';
}

type RawPlanStep = {
    id?: string;
    title?: string;
    description?: string;
    status?: string;
};

export function parsePlanStepsFromPayload(payload: unknown): PlanStep[] | undefined {
    if (!payload) return undefined;
    let raw: RawPlanStep[] | undefined;
    if (Array.isArray(payload)) {
        raw = payload as RawPlanStep[];
    } else if (typeof payload === 'object') {
        const obj = payload as { steps?: RawPlanStep[] };
        if (Array.isArray(obj.steps) && obj.steps.length > 0) raw = obj.steps;
    }
    if (!raw?.length) return undefined;
    return raw.map((s, i) => ({
        id: s.id ?? `step-${i}`,
        title: (s.title ?? s.description ?? '').trim() || `Step ${i + 1}`,
        status: normalizePlanStatus(s.status),
    }));
}

export type PlanProgressPayload = {
    stepId?: string;
    stepIndex?: number;
    status?: string;
    completedSteps?: number;
};

function stepIndexFromPlanId(stepId: string | undefined): number | undefined {
    if (!stepId) return undefined;
    const m = /^(?:s|p)(\d+)$/i.exec(stepId.trim());
    if (!m) return undefined;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n - 1 : undefined;
}

export function applyPlanProgress(plan: PlanStep[], data: PlanProgressPayload): PlanStep[] {
    if (!plan.length) return plan;
    const phaseIdx = stepIndexFromPlanId(data.stepId);
    let updated = plan.map((step, idx) => {
        const nextStatus = data.status ? normalizePlanStatus(data.status) : step.status;
        if (data.stepId && step.id === data.stepId) return { ...step, status: nextStatus };
        if (data.stepIndex !== undefined && idx === data.stepIndex) return { ...step, status: nextStatus };
        if (phaseIdx !== undefined && idx === phaseIdx) return { ...step, status: nextStatus };
        return step;
    });
    if (data.completedSteps !== undefined && data.completedSteps > 0) {
        updated = updated.map((step, i) => {
            if (i < data.completedSteps! && (step.status === 'pending' || step.status === 'running')) {
                return { ...step, status: 'success' as const };
            }
            return step;
        });
    }
    return updated;
}
