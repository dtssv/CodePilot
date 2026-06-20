/**
 * Hydrate v2 chat store from legacy session_messages payload (messages.ndjson replay).
 * Prefer envelope replay (see hydrateChatV2FromEnvelopes); this path interleaves by tool timestamps.
 */

import type { AgentStep } from '../components/AgentStepCard';
import type { ToolExecutionState } from './chatTypes';
import type { ChatV2State, StepNode, TurnNode } from './events';
import { normalizePlanStatus } from './planNormalize';
import { classifyToolResult, isReadLikeTool, isWriteLikeTool } from '../utils/toolResultClassify';
import { normalizeToolArgs } from '../utils/toolArgs';

export interface LegacyHydrateMessage {
    role: string;
    content?: string;
    contextRefs?: { id?: string; display: string; type?: string }[];
    images?: { url: string; mimeType?: string; name?: string; description?: string }[];
    turnId?: string;
    planSteps?: { id: string; title: string; status: string }[];
    agentSteps?: AgentStep[];
    toolCalls?: {
        id: string;
        name: string;
        args: Record<string, unknown>;
        status?: string;
        result?: Record<string, unknown>;
        executionState?: string;
        startedAt?: string;
        resultAt?: string;
    }[];
}

function mapAgentKind(type: AgentStep['type']): string {
    if (type === 'checking') return 'verify';
    return type;
}

function toolOk(tc: {
    status?: string;
    executionState?: string;
}): boolean {
    return tc.status !== 'error'
        && tc.executionState !== 'denied'
        && tc.executionState !== 'skipped';
}

function pathFromArgs(args: Record<string, unknown>): string {
    const p = args.path ?? args.file ?? args.target;
    return p != null ? String(p) : '';
}

function parseTs(ts?: string): number {
    if (!ts) return 0;
    const n = Date.parse(ts);
    return Number.isFinite(n) ? n : 0;
}

type TimelineEntry = { orderKey: number; add: () => void };

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
        let hydrateOrderSeq = 0;
        let syntheticReadingEmitted = false;
        const writingFiles: { path: string; op: string }[] = [];

        const addStep = (step: StepNode) => {
            const seq = hydrateOrderSeq++;
            steps[step.stepId] = {
                ...step,
                orderSeq: step.orderSeq ?? seq,
                startedAt: step.startedAt + seq,
            };
            turn.stepIds.push(step.stepId);
            if (!step.parentStepId) turn.rootStepIds.push(step.stepId);
        };

        const timeline: TimelineEntry[] = [];
        let maxOrderKey = startedAt;

        const bumpMax = (k: number) => {
            if (k > maxOrderKey) maxOrderKey = k;
        };

        if (assistant.planSteps && assistant.planSteps.length > 0) {
            timeline.push({
                orderKey: startedAt,
                add: () => {
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
                        plan: assistant.planSteps!.map((s) => ({
                            id: s.id,
                            title: s.title,
                            status: normalizePlanStatus(s.status),
                        })),
                        children: [],
                    });
                },
            });
        }

        const persistedAgentTypes = new Set((assistant.agentSteps ?? []).map((a) => a.type));
        const tools = [...(assistant.toolCalls ?? [])].sort(
            (a, b) => parseTs(a.startedAt) - parseTs(b.startedAt) || 0,
        );
        const agents = assistant.agentSteps ?? [];

        const addTool = (tc: NonNullable<LegacyHydrateMessage['toolCalls']>[number]) => {
            const toolName = tc.name || 'unknown';
            const args = normalizeToolArgs(tc.args);
            const ok = toolOk(tc);

            if (isReadLikeTool(toolName) && !syntheticReadingEmitted && !persistedAgentTypes.has('reading')) {
                const path = pathFromArgs(args);
                const sid = `${turnId}-read-${stepCounter++}`;
                addStep({
                    stepId: sid,
                    kind: 'reading',
                    title: path ? `Reading ${path}` : 'Reading files',
                    status: 'success',
                    startedAt,
                    endedAt: startedAt + 50,
                    textBuf: '',
                    thinkingBuf: '',
                    progressDetail: path ? { files: [{ path, op: 'read' }] } : undefined,
                    children: [],
                });
                syntheticReadingEmitted = true;
            }

            const sid = tc.id || `${turnId}-tool-${stepCounter++}`;
            stepCounter += 1;
            const hasResult = Boolean(tc.result && Object.keys(tc.result).length > 0);
            const stepStatus =
                tc.status === 'error' ? 'error'
                : tc.status === 'running' && !hasResult ? 'running'
                : 'success';
            const classified = classifyToolResult(
                toolName,
                args,
                ok,
                hasResult ? tc.result : null,
                null,
                ok ? null : 'Tool failed',
            );

            addStep({
                stepId: sid,
                kind: 'tool',
                title: toolName,
                status: stepStatus,
                startedAt,
                endedAt: startedAt + 300,
                textBuf: '',
                thinkingBuf: '',
                executionState: tc.executionState as ToolExecutionState | undefined,
                toolCall: { tool: toolName, args },
                toolResult: { ok, result: classified },
                children: [],
            });

            if (isWriteLikeTool(toolName) && ok) {
                const path = pathFromArgs(args) || String((classified as { path?: string }).path ?? '');
                if (path) {
                    const op = toolName === 'fs.delete' ? 'delete'
                        : toolName === 'fs.create' ? 'create'
                        : 'write';
                    const existing = writingFiles.findIndex((f) => f.path === path);
                    const entry = { path, op };
                    if (existing >= 0) writingFiles[existing] = entry;
                    else writingFiles.push(entry);
                }
            }
        };

        const addAgent = (as: AgentStep) => {
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
        };

        // Interleave agents and tools by index; tools use persisted timestamps when available.
        const pairLen = Math.max(tools.length, agents.length);
        for (let idx = 0; idx < pairLen; idx++) {
            const agent = agents[idx];
            const tool = tools[idx];
            if (agent) {
                const key = startedAt + idx * 2;
                bumpMax(key);
                timeline.push({ orderKey: key, add: () => addAgent(agent) });
            }
            if (tool) {
                const key = parseTs(tool.startedAt) || parseTs(tool.resultAt) || startedAt + idx * 2 + 1;
                bumpMax(key);
                timeline.push({ orderKey: key, add: () => addTool(tool) });
            }
        }

        if (writingFiles.length > 0 && !persistedAgentTypes.has('writing')) {
            const summary = writingFiles.map((f) => {
                const label = f.op === 'create' ? '新建' : f.op === 'delete' ? '删除' : '修改';
                return `${label}: ${f.path}`;
            }).join(', ');
            const key = maxOrderKey + 1;
            bumpMax(key);
            timeline.push({
                orderKey: key,
                add: () => {
                    const sid = `${turnId}-writing-${stepCounter++}`;
                    addStep({
                        stepId: sid,
                        kind: 'writing',
                        title: summary,
                        status: 'success',
                        startedAt,
                        endedAt: startedAt + 200,
                        textBuf: '',
                        thinkingBuf: '',
                        progressDetail: { files: writingFiles },
                        children: [],
                    });
                },
            });
        }

        if (assistant.content && assistant.content.trim()) {
            const key = maxOrderKey + 10;
            timeline.push({
                orderKey: key,
                add: () => {
                    const sid = `${turnId}-llm-${stepCounter++}`;
                    addStep({
                        stepId: sid,
                        kind: 'llm',
                        title: 'Assistant',
                        status: 'success',
                        startedAt,
                        endedAt: startedAt + 500,
                        textBuf: assistant.content!,
                        thinkingBuf: '',
                        children: [],
                    });
                },
            });
        }

        timeline.sort((a, b) => a.orderKey - b.orderKey).forEach((e) => e.add());

        turns.push(turn);
    }

    return { turns, steps, lastSeq: 0, pending: [] };
}
