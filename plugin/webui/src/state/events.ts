/**
 * v2 event protocol — see doc/01-event-protocol.md.
 *
 * Runs in parallel with the legacy event channel (delta / tool_call / done /
 * agent_*). Both channels are produced by the plugin host today; the v2 store
 * here only consumes `envelope` events.
 */

export type StepKind = 'llm' | 'thinking' | 'tool' | 'plan' | 'subtask' | string;
export type TurnStatus = 'running' | 'final' | 'failed' | 'stopped' | 'interrupted' | 'max_steps';
export type StepStatus = 'running' | 'success' | 'error' | 'cancelled';

export type EventType =
    | 'turn.start' | 'turn.end' | 'turn.metrics'
    | 'step.start' | 'step.progress' | 'step.end'
    | 'text.delta' | 'text.thinking'
    | 'tool.call' | 'tool.progress' | 'tool.result'
    | 'plan.update' | 'plan.progress'
    | 'needs_input' | 'risk_notice'
    | 'error'
    | string; // forward-compatible

export interface EventEnvelope {
    seq: number;
    turnId: string;
    stepId: string;
    parentStepId?: string | null;
    ts: number;
    type: EventType;
    payload: unknown;
}

export interface PlanStep {
    id: string;
    title: string;
    status: 'pending' | 'running' | 'success' | 'error' | string;
}

export type { ToolExecutionState } from './chatTypes';

export interface StepNode {
    stepId: string;
    /** Restored from persisted toolCalls (denied/skipped/success). */
    executionState?: import('./chatTypes').ToolExecutionState;
    parentStepId?: string | null;
    kind: StepKind;
    title: string;
    status: StepStatus;
    startedAt: number;
    endedAt?: number;
    /** Envelope seq at step.start — stable chronological order in the UI. */
    orderSeq?: number;

    /** Streamed text for LLM steps. */
    textBuf: string;
    /** Streamed thinking text for THINKING steps. */
    thinkingBuf: string;

    toolCall?: { tool: string; args: unknown };
    toolResult?: { ok: boolean; result?: unknown; error?: string | null };
    plan?: PlanStep[];
    /** Most recent tool.progress payload (UI consumers should accumulate as needed). */
    progressDetail?: unknown;
    /** Last error message attached to this step, if any. */
    error?: string;

    /** Direct children stepIds for display purposes. */
    children: string[];
}

export interface RiskNotice {
    level: string;
    message: string;
    filesPaths?: string[];
}

export interface NeedsInputPayload {
    title?: string;
    questions?: { id: string; prompt: string; kind?: string; options?: { id: string; label: string }[] }[];
    continuationToken?: string;
}

export interface TurnImage {
    url: string;
    mimeType?: string;
    name?: string;
    description?: string;
}

/** One graph-node Skill activation batch (planning / generate / repair). */
export interface SkillActivationRecord {
    node: string;
    skills: {
        id: string;
        version?: string;
        source?: string;
        scope?: string;
        priority?: number;
        tokens?: number;
    }[];
    ts: number;
}

export interface TurnNode {
    turnId: string;
    userMessage: string;
    contextRefs: { display?: string; type?: string }[];
    images?: TurnImage[];
    /** Index in session messages.ndjson for fork_from_message. */
    forkMessageIndex?: number;
    riskNotices?: RiskNotice[];
    needsInput?: NeedsInputPayload;
    /** Chronological Skill activations per graph node within this turn. */
    skillActivations?: SkillActivationRecord[];
    status: TurnStatus;
    /** Root-level steps (parentStepId == null). */
    rootStepIds: string[];
    /** Insertion order across all steps in this turn — main rendering list. */
    stepIds: string[];
    startedAt: number;
    endedAt?: number;
    reason?: string | null;
    tokenMeta?: {
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
        modelId?: string;
        tier?: string;
    };
}

export interface ChatV2State {
    turns: TurnNode[];
    steps: Record<string, StepNode>;
    /** Highest seq observed and applied so far. */
    lastSeq: number;
    /** Envelopes received out-of-order, waiting for the gap to close. */
    pending: EventEnvelope[];
}

export const INITIAL_V2_STATE: ChatV2State = {
    turns: [],
    steps: {},
    lastSeq: 0,
    pending: [],
};
