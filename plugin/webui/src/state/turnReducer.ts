import type {
    ChatV2State,
    EventEnvelope,
    PlanStep,
    StepNode,
    StepStatus,
    TurnNode,
    TurnStatus,
} from './events';

/** Cast helper that keeps the call sites readable. */
const P = <T>(payload: unknown): T => payload as T;

/**
 * Pure reducer for the v2 event protocol. Never mutates input state.
 *
 * Ordering is enforced by [applyEnvelope]; this reducer assumes the envelope is
 * the immediate successor of state.lastSeq, or a turn-scoped event whose
 * turn/step has already been created.
 */
export function reduceEnvelope(state: ChatV2State, ev: EventEnvelope): ChatV2State {
    if (ev.seq <= state.lastSeq) return state;
    const base: ChatV2State = { ...state, lastSeq: ev.seq };

    switch (ev.type) {
        case 'turn.start': {
            const p = P<{ userMessage?: string; contextRefs?: TurnNode['contextRefs'] }>(ev.payload);
            const turn: TurnNode = {
                turnId: ev.turnId,
                userMessage: p?.userMessage ?? '',
                contextRefs: p?.contextRefs ?? [],
                status: 'running',
                rootStepIds: [],
                stepIds: [],
                startedAt: ev.ts,
            };
            return { ...base, turns: [...state.turns, turn] };
        }

        case 'turn.end': {
            const p = P<{ status?: TurnStatus; reason?: string | null }>(ev.payload);
            return {
                ...base,
                turns: state.turns.map((t) =>
                    t.turnId === ev.turnId
                        ? { ...t, status: p?.status ?? 'final', endedAt: ev.ts, reason: p?.reason ?? null }
                        : t,
                ),
            };
        }

        case 'step.start': {
            const p = P<{ stepId: string; kind: string; title?: string; parentStepId?: string | null }>(ev.payload);
            if (!p?.stepId) return base;
            const stepId = p.stepId;
            const step: StepNode = {
                stepId,
                parentStepId: p.parentStepId ?? ev.parentStepId ?? null,
                kind: p.kind ?? 'llm',
                title: p.title ?? '',
                status: 'running',
                startedAt: ev.ts,
                textBuf: '',
                thinkingBuf: '',
                children: [],
            };
            const steps: Record<string, StepNode> = { ...state.steps, [stepId]: step };
            if (step.parentStepId && steps[step.parentStepId]) {
                const parent = steps[step.parentStepId];
                if (!parent.children.includes(stepId)) {
                    steps[step.parentStepId] = { ...parent, children: [...parent.children, stepId] };
                }
            }
            const turns = state.turns.map((t) => {
                if (t.turnId !== ev.turnId) return t;
                const stepIds = t.stepIds.includes(stepId) ? t.stepIds : [...t.stepIds, stepId];
                const rootStepIds = step.parentStepId
                    ? t.rootStepIds
                    : t.rootStepIds.includes(stepId)
                        ? t.rootStepIds
                        : [...t.rootStepIds, stepId];
                return { ...t, stepIds, rootStepIds };
            });
            return { ...base, steps, turns };
        }

        case 'step.end': {
            const p = P<{ stepId: string; status?: StepStatus; error?: string | null }>(ev.payload);
            if (!p?.stepId) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            // Only transition out of running — terminal statuses are sticky.
            if (cur.status !== 'running') return base;
            return {
                ...base,
                steps: {
                    ...state.steps,
                    [p.stepId]: {
                        ...cur,
                        status: p.status ?? 'success',
                        endedAt: ev.ts,
                        error: p.error ?? cur.error,
                    },
                },
            };
        }

        case 'text.delta': {
            const p = P<{ stepId: string; text?: string }>(ev.payload);
            if (!p?.stepId || !p.text) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: { ...state.steps, [p.stepId]: { ...cur, textBuf: cur.textBuf + p.text } },
            };
        }

        case 'text.thinking': {
            const p = P<{ stepId: string; text?: string }>(ev.payload);
            if (!p?.stepId || !p.text) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: { ...state.steps, [p.stepId]: { ...cur, thinkingBuf: cur.thinkingBuf + p.text } },
            };
        }

        case 'tool.call': {
            const p = P<{ stepId: string; tool: string; args: unknown }>(ev.payload);
            if (!p?.stepId) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: {
                    ...state.steps,
                    [p.stepId]: { ...cur, toolCall: { tool: p.tool, args: p.args } },
                },
            };
        }

        case 'tool.progress': {
            const p = P<{ stepId: string; partial: unknown }>(ev.payload);
            if (!p?.stepId) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: { ...state.steps, [p.stepId]: { ...cur, progressDetail: p.partial } },
            };
        }

        case 'tool.result': {
            const p = P<{ stepId: string; ok: boolean; result?: unknown; error?: string | null }>(ev.payload);
            if (!p?.stepId) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: {
                    ...state.steps,
                    [p.stepId]: {
                        ...cur,
                        toolResult: { ok: p.ok, result: p.result, error: p.error ?? null },
                        // tool.result is informational; final status comes from step.end.
                    },
                },
            };
        }

        case 'plan.update': {
            const p = P<{ steps?: PlanStep[] } | PlanStep[]>(ev.payload);
            const steps: PlanStep[] | undefined = Array.isArray(p)
                ? (p as PlanStep[])
                : (p as { steps?: PlanStep[] })?.steps;
            if (!steps || steps.length === 0) return base;
            const cur = state.steps[ev.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: { ...state.steps, [ev.stepId]: { ...cur, plan: steps } },
            };
        }

        case 'error': {
            const p = P<{ code?: number; message?: string }>(ev.payload);
            const cur = state.steps[ev.stepId];
            if (cur) {
                return {
                    ...base,
                    steps: { ...state.steps, [ev.stepId]: { ...cur, error: p?.message ?? 'error' } },
                };
            }
            return base;
        }

        // needs_input / risk_notice / tool.progress fallthroughs handled by callers
        // that wish to surface UI overlays; reducer keeps them only via step state.
        default:
            return base;
    }
}

/**
 * Apply a single envelope, handling out-of-order delivery.
 *
 * Returns the new state and an optional `requestReplayFrom` seq number — when
 * present, the caller MUST send `replay_since { lastSeq: requestReplayFrom }`
 * to the plugin so it can re-emit any missing envelopes.
 */
export function applyEnvelope(
    state: ChatV2State,
    ev: EventEnvelope,
): { next: ChatV2State; requestReplayFrom?: number } {
    // Duplicate — drop silently
    if (ev.seq <= state.lastSeq) return { next: state };

    // Future envelope — buffer and request gap recovery if it's the first missing.
    if (ev.seq > state.lastSeq + 1) {
        const alreadyBuffered = state.pending.some((p) => p.seq === ev.seq);
        const pending = alreadyBuffered ? state.pending : [...state.pending, ev].sort((a, b) => a.seq - b.seq);
        return {
            next: { ...state, pending },
            // Only ask once per gap; caller may de-dupe by its own timer.
            requestReplayFrom: state.lastSeq,
        };
    }

    // Apply this envelope, then drain any pending that are now contiguous.
    let next = reduceEnvelope(state, ev);
    if (state.pending.length === 0) return { next };

    const remaining: EventEnvelope[] = [];
    for (const p of state.pending) {
        if (p.seq <= next.lastSeq) continue; // stale
        if (p.seq === next.lastSeq + 1) next = reduceEnvelope(next, p);
        else remaining.push(p);
    }
    next = { ...next, pending: remaining };
    return { next };
}
