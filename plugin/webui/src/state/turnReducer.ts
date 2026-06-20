import type {
    ChatV2State,
    EventEnvelope,
    StepNode,
    StepStatus,
    TurnNode,
    TurnStatus,
} from './events';
import {
    applyPlanProgress,
    parsePlanStepsFromPayload,
    type PlanProgressPayload,
} from './planNormalize';
import { stripGraphMarkers } from '../utils/graphMarkers';
import { normalizeToolArgs, parseToolResultPayload } from '../utils/toolArgs';
import { classifyToolResult } from '../utils/toolResultClassify';

/** Cast helper that keeps the call sites readable. */
const P = <T>(payload: unknown): T => payload as T;

function toolStepTitle(tool: string, args: Record<string, unknown>, fallback: string): string {
    const path = String(args.path ?? '').trim();
    const command = String(args.command ?? '').trim();
    if ((tool === 'shell.exec' || tool === 'shell.session') && command) return command;
    if ((tool.startsWith('fs.') || tool.startsWith('ide.') || tool.startsWith('code.')) && path) {
        return path;
    }
    return fallback;
}

type ShellPartial = {
    stream?: string;
    line?: string;
    stdout?: string;
    stderr?: string;
    command?: string;
    exitCode?: number;
    durationMs?: number;
    kind?: string;
};

function mergeProgressDetail(cur: StepNode, partial: unknown): StepNode {
    const p = (partial ?? {}) as ShellPartial;
    const prev = (cur.progressDetail ?? {}) as ShellPartial;
    let stdout = String(prev.stdout ?? '');
    let stderr = String(prev.stderr ?? '');
    if (p.line != null && p.line !== '') {
        if (p.stream === 'stderr') stderr += `${p.line}\n`;
        else stdout += `${p.line}\n`;
    }
    if (p.stdout != null) stdout = String(p.stdout);
    if (p.stderr != null) stderr = String(p.stderr);
    const merged: ShellPartial = {
        ...prev,
        ...p,
        stdout,
        stderr,
        kind: p.kind ?? prev.kind ?? (cur.toolCall?.tool?.startsWith('shell.') ? 'shell' : undefined),
        command: p.command ?? prev.command ?? String(normalizeToolArgs(cur.toolCall?.args).command ?? ''),
    };
    return { ...cur, progressDetail: merged };
}

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
            if (state.turns.some((t) => t.turnId === ev.turnId)) {
                return base;
            }
            const p = P<{
                userMessage?: string;
                contextRefs?: TurnNode['contextRefs'];
                images?: TurnNode['images'];
                forkMessageIndex?: number;
            }>(ev.payload);
            const turn: TurnNode = {
                turnId: ev.turnId,
                userMessage: p?.userMessage ?? '',
                contextRefs: p?.contextRefs ?? [],
                images: p?.images ?? [],
                forkMessageIndex: p?.forkMessageIndex,
                status: 'running',
                rootStepIds: [],
                stepIds: [],
                startedAt: ev.ts,
            };
            return { ...base, turns: [...state.turns, turn] };
        }

        case 'turn.end': {
            const p = P<{ status?: TurnStatus; reason?: string | null }>(ev.payload);
            const turn = state.turns.find((t) => t.turnId === ev.turnId);
            const steps = { ...state.steps };
            if (turn) {
                for (const stepId of turn.stepIds) {
                    const step = steps[stepId];
                    if (step?.status === 'running') {
                        steps[stepId] = { ...step, status: 'success', endedAt: ev.ts };
                    }
                }
            }
            return {
                ...base,
                steps,
                turns: state.turns.map((t) =>
                    t.turnId === ev.turnId
                        ? { ...t, status: p?.status ?? 'final', endedAt: ev.ts, reason: p?.reason ?? null }
                        : t,
                ),
            };
        }

        case 'turn.metrics': {
            const p = P<{
                inputTokens?: number;
                outputTokens?: number;
                costUsd?: number;
                modelId?: string;
                tier?: string;
            }>(ev.payload);
            return {
                ...base,
                turns: state.turns.map((t) =>
                    t.turnId === ev.turnId ? { ...t, tokenMeta: { ...t.tokenMeta, ...p } } : t,
                ),
            };
        }

        case 'step.start': {
            const p = P<{
                stepId: string;
                kind: string;
                title?: string;
                parentStepId?: string | null;
                detail?: { files?: { path: string; op?: string; lineCount?: number; preview?: string }[] };
            }>(ev.payload);
            if (!p?.stepId) return base;
            const stepId = p.stepId;
            const step: StepNode = {
                stepId,
                parentStepId: p.parentStepId ?? ev.parentStepId ?? null,
                kind: p.kind ?? 'llm',
                title: p.title ?? '',
                status: 'running',
                startedAt: ev.ts,
                orderSeq: ev.seq,
                textBuf: '',
                thinkingBuf: '',
                children: [],
                progressDetail: p.detail ?? undefined,
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

        case 'step.progress': {
            const p = P<{
                stepId: string;
                partial?: {
                    files?: { path: string; op?: string; lineCount?: number; preview?: string }[];
                    text?: string;
                    kind?: string;
                };
            }>(ev.payload);
            if (!p?.stepId) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            const partial = p.partial ?? {};
            const prev = (cur.progressDetail ?? {}) as {
                files?: { path: string; op?: string; lineCount?: number; preview?: string }[];
            };
            return {
                ...base,
                steps: {
                    ...state.steps,
                    [p.stepId]: {
                        ...cur,
                        title: partial.text?.trim() ? partial.text : cur.title,
                        progressDetail: {
                            ...prev,
                            ...partial,
                            files: partial.files ?? prev.files,
                        },
                    },
                },
            };
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
            const text = p?.text ? stripGraphMarkers(p.text) : '';
            if (!p?.stepId || !text) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: { ...state.steps, [p.stepId]: { ...cur, textBuf: cur.textBuf + text } },
            };
        }

        case 'text.thinking': {
            const p = P<{ stepId: string; text?: string }>(ev.payload);
            const text = p?.text ? stripGraphMarkers(p.text) : '';
            if (!p?.stepId || !text) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: { ...state.steps, [p.stepId]: { ...cur, thinkingBuf: cur.thinkingBuf + text } },
            };
        }

        case 'tool.call': {
            const p = P<{ stepId: string; tool: string; args: unknown }>(ev.payload);
            if (!p?.stepId) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            const args = normalizeToolArgs(p.args);
            const title = toolStepTitle(p.tool, args, cur.title);
            return {
                ...base,
                steps: {
                    ...state.steps,
                    [p.stepId]: {
                        ...cur,
                        title,
                        toolCall: { tool: p.tool, args },
                        progressDetail: {
                            ...(cur.progressDetail as object),
                            kind: p.tool.startsWith('shell.') ? 'shell' : (cur.progressDetail as { kind?: string })?.kind,
                            command: args.command ?? (cur.progressDetail as { command?: string })?.command,
                        },
                    },
                },
            };
        }

        case 'tool.progress':
        case 'shell.progress': {
            const p = P<{ stepId: string; partial?: unknown }>(ev.payload);
            const stepId = p?.stepId ?? ev.stepId;
            if (!stepId) return base;
            const cur = state.steps[stepId];
            if (!cur) return base;
            const merged = mergeProgressDetail(cur, p?.partial ?? ev.payload);
            return {
                ...base,
                steps: { ...state.steps, [stepId]: merged },
            };
        }

        case 'tool.result': {
            const p = P<{ stepId: string; ok: boolean; result?: unknown; error?: string | null }>(ev.payload);
            if (!p?.stepId) return base;
            const cur = state.steps[p.stepId];
            if (!cur) return base;
            const toolName = cur.toolCall?.tool ?? '';
            const args = normalizeToolArgs(cur.toolCall?.args);
            const rawResult = parseToolResultPayload(p.result);
            const errFromPayload =
                p.error
                ?? (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
                    ? String((rawResult as { errorMessage?: string }).errorMessage ?? '') || null
                    : null);
            const classified = toolName
                ? classifyToolResult(toolName, args, p.ok, rawResult, null, errFromPayload)
                : rawResult;
            return {
                ...base,
                steps: {
                    ...state.steps,
                    [p.stepId]: {
                        ...cur,
                        toolResult: { ok: p.ok, result: classified, error: errFromPayload },
                        // tool.result is informational; final status comes from step.end.
                    },
                },
            };
        }

        case 'plan.update': {
            const steps = parsePlanStepsFromPayload(ev.payload);
            if (!steps || steps.length === 0) return base;
            const cur = state.steps[ev.stepId];
            if (!cur) return base;
            return {
                ...base,
                steps: { ...state.steps, [ev.stepId]: { ...cur, plan: steps } },
            };
        }

        case 'plan.progress': {
            const data = P<PlanProgressPayload>(ev.payload);
            const cur = state.steps[ev.stepId];
            if (!cur?.plan?.length) return base;
            return {
                ...base,
                steps: {
                    ...state.steps,
                    [ev.stepId]: { ...cur, plan: applyPlanProgress(cur.plan, data) },
                },
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

        case 'risk_notice': {
            const p = P<{ level?: string; message?: string; filesPaths?: string[] }>(ev.payload);
            const notice = {
                level: p?.level ?? 'warn',
                message: p?.message ?? '',
                filesPaths: p?.filesPaths,
            };
            return {
                ...base,
                turns: state.turns.map((t) =>
                    t.turnId === ev.turnId
                        ? { ...t, riskNotices: [...(t.riskNotices ?? []), notice] }
                        : t,
                ),
            };
        }

        case 'needs_input': {
            const p = P<TurnNode['needsInput']>(ev.payload);
            return {
                ...base,
                turns: state.turns.map((t) =>
                    t.turnId === ev.turnId ? { ...t, needsInput: p ?? t.needsInput } : t,
                ),
            };
        }

        case 'subagent_spawn': {
            const p = P<{ taskId?: string; agentName?: string; description?: string }>(ev.payload);
            if (!p?.taskId) return base;
            return {
                ...base,
                turns: state.turns.map((t) => {
                    if (t.turnId !== ev.turnId) return t;
                    const subagents = t.subagents ?? [];
                    if (subagents.some((s) => s.taskId === p.taskId)) return t;
                    return {
                        ...t,
                        subagents: [
                            ...subagents,
                            {
                                taskId: p.taskId!,
                                agentName: p.agentName ?? 'general',
                                description: p.description ?? '',
                                status: 'running',
                                startedAt: ev.ts,
                            },
                        ],
                    };
                }),
            };
        }

        case 'subagent_progress':
        case 'subagent_complete':
        case 'subagent_failed': {
            const p = P<{ taskId?: string; status?: string; progress?: string; result?: string; error?: string }>(
                ev.payload,
            );
            if (!p?.taskId) return base;
            return {
                ...base,
                turns: state.turns.map((t) => {
                    if (t.turnId !== ev.turnId) return t;
                    const subagents = t.subagents ?? [];
                    const idx = subagents.findIndex((s) => s.taskId === p.taskId);
                    const existing = idx >= 0
                        ? subagents[idx]
                        : {
                            taskId: p.taskId!,
                            agentName: 'general',
                            description: '',
                            status: 'running' as const,
                            startedAt: ev.ts,
                        };
                    const updated = { ...existing };
                    if (ev.type === 'subagent_progress') {
                        updated.status = 'running';
                        updated.progress = p.progress ?? p.status ?? updated.progress;
                    } else if (ev.type === 'subagent_complete') {
                        updated.status = 'success';
                        updated.result = p.result ?? updated.result;
                        updated.endedAt = ev.ts;
                    } else {
                        updated.status = 'error';
                        updated.error = p.error ?? updated.error;
                        updated.endedAt = ev.ts;
                    }
                    const next = idx >= 0
                        ? subagents.map((s, i) => (i === idx ? updated : s))
                        : [...subagents, updated];
                    return { ...t, subagents: next };
                }),
            };
        }

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
