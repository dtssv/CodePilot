/**
 * Hydrate v2 chat store from legacy session_messages payload (messages.ndjson replay).
 */

import type { AgentStep } from '../components/AgentStepCard';
import type { ChatV2State, StepNode, TurnNode } from './events';
import { normalizePlanStatus } from './planNormalize';

export interface LegacyHydrateMessage {
    role: string;
    content?: string;
    contextRefs?: { id?: string; display: string; type?: string }[];
    images?: { url: string; mimeType?: string; name?: string; description?: string }[];
    turnId?: string;
    planSteps?: { id: string; title: string; status: string }[];
    agentSteps?: AgentStep[];
    toolCalls?: { id: string; name: string; args: Record<string, unknown>; status?: string }[];
}

function mapAgentKind(type: AgentStep['type']): string {
    if (type === 'checking') return 'verify';
    return type;
}

/** Build a read-only v2 state snapshot from persisted legacy messages. */
export function buildV2StateFromLegacyMessages(messages: LegacyHydrateMessage[]): ChatV2State {
    const turns: TurnNode[] = [];
    const steps: Record<string, StepNode> = {};
    const baseTs = Date.now() - messages.length * 2000;

    let i = 0;
    let turnIndex = 0;
    while (i < messages.length) {
        const msg = messages[i];
        if (msg.role !== 'user') {
            i += 1;
            continue;
        }
        const userMsgIndex = i;
        const turnId = msg.turnId || `hist-turn-${turnIndex}`;
        const startedAt = baseTs + turnIndex * 2000;
        const contextRefs = (msg.contextRefs ?? []).map((r) => ({
            display: r.display,
            type: r.type,
        }));
        const images = (msg.images ?? []).map((img) => ({
            url: img.url,
            mimeType: img.mimeType,
            name: img.name,
            description: img.description,
        }));
        const turn: TurnNode = {
            turnId,
            userMessage: msg.content || '',
            contextRefs,
            images,
            forkMessageIndex: userMsgIndex,
            status: 'final',
            rootStepIds: [],
            stepIds: [],
            startedAt,
            endedAt: startedAt + 1500,
        };
        i += 1;
        turnIndex += 1;

        if (i >= messages.length || messages[i].role !== 'assistant') {
            turns.push(turn);
            continue;
        }
        const assistant = messages[i];
        i += 1;
        let stepCounter = 0;

        const addStep = (step: StepNode) => {
            steps[step.stepId] = step;
            turn.stepIds.push(step.stepId);
            if (!step.parentStepId) turn.rootStepIds.push(step.stepId);
        };

        if (assistant.planSteps && assistant.planSteps.length > 0) {
            const sid = `${turnId}-plan-${stepCounter++}`;
            addStep({
                stepId: sid,
                kind: 'plan',
                title: '执行计划',
                status: 'success',
                startedAt,
                endedAt: startedAt + 100,
                textBuf: '',
                thinkingBuf: '',
                plan: assistant.planSteps.map((s) => ({
                    id: s.id,
                    title: s.title,
                    status: normalizePlanStatus(s.status),
                })),
                children: [],
            });
        }

        for (const as of assistant.agentSteps || []) {
            const sid = `${turnId}-agent-${stepCounter++}`;
            addStep({
                stepId: sid,
                kind: mapAgentKind(as.type),
                title: as.content || as.type,
                status: as.status === 'error' ? 'error' : 'success',
                startedAt,
                endedAt: startedAt + 200,
                textBuf: '',
                thinkingBuf: '',
                progressDetail: as.detail,
                children: [],
            });
        }

        for (const tc of assistant.toolCalls || []) {
            const sid = `${turnId}-tool-${stepCounter++}`;
            const isShell = tc.name.startsWith('shell.');
            addStep({
                stepId: sid,
                kind: 'tool',
                title: tc.name,
                status: tc.status === 'error' ? 'error' : 'success',
                startedAt,
                endedAt: startedAt + 300,
                textBuf: '',
                thinkingBuf: '',
                toolCall: { tool: tc.name, args: tc.args || {} },
                toolResult: { ok: tc.status !== 'error', result: isShell ? { kind: 'shell', command: (tc.args as { command?: string }).command } : tc.args },
                children: [],
            });
        }

        if (assistant.content && assistant.content.trim()) {
            const sid = `${turnId}-llm-${stepCounter++}`;
            addStep({
                stepId: sid,
                kind: 'llm',
                title: 'Assistant',
                status: 'success',
                startedAt,
                endedAt: startedAt + 500,
                textBuf: assistant.content,
                thinkingBuf: '',
                children: [],
            });
        }

        turns.push(turn);
    }

    return { turns, steps, lastSeq: 0, pending: [] };
}
