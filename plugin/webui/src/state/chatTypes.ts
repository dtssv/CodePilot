/** Legacy chat message shape (pre-v2 / parallel persistence). */

import type { AgentStep } from '../components/AgentStepCard';

export interface ToolCallInfo {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status?: 'running' | 'success' | 'error';
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
    _streaming?: boolean;
    ts?: string;
    turnId?: string;
}
