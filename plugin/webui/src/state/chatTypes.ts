/** Legacy chat message shape (pre-v2 / parallel persistence). */

import type { AgentStep } from '../components/AgentStepCard';

export type ToolExecutionState = 'running' | 'success' | 'error' | 'denied' | 'skipped';

export interface ToolCallInfo {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status?: 'running' | 'success' | 'error';
    /** Terminal UI state including user deny/skip on shell permission. */
    executionState?: ToolExecutionState;
    result?: Record<string, unknown>;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    contextRefs?: { display: string; type?: string }[];
    toolCall?: { id: string; name: string; args: unknown };
    toolCalls?: ToolCallInfo[];
    riskNotice?: { level: string; message: string; filesPaths: string[] };
    needsInput?: {
        title?: string;
        questions?: { id: string; prompt: string; kind?: string; options?: { id: string; label: string }[] }[];
        continuationToken?: string;
    };
    diff?: { path: string; hunks: string };
    images?: { url: string; mimeType?: string; description?: string }[];
    agentSteps?: AgentStep[];
    planSteps?: { id: string; title: string; status: string }[];
    skillActivations?: {
        node: string;
        skills: { id: string; version?: string; source?: string; scope?: string; priority?: number; tokens?: number }[];
        ts: number;
    }[];
    _streaming?: boolean;
    ts?: string;
    turnId?: string;
}
