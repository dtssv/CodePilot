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
    | 'turn.start' | 'turn.end'
    | 'step.start' | 'step.progress' | 'step.end'
    | 'text.delta' | 'text.thinking'
    | 'tool.call' | 'tool.progress' | 'tool.result'
    | 'plan.update'
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

export interface StepNode {
    stepId: string;
    parentStepId?: string | null;
    kind: StepKind;
    title: string;
    status: StepStatus;
    startedAt: number;
    endedAt?: number;

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

export interface TurnNode {
    turnId: string;
    userMessage: string;
    contextRefs: { display?: string; type?: string }[];
    status: TurnStatus;
    /** Root-level steps (parentStepId == null). */
    rootStepIds: string[];
    /** Insertion order across all steps in this turn — main rendering list. */
    stepIds: string[];
    startedAt: number;
    endedAt?: number;
    reason?: string | null;
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
