/**
 * Legacy chat SSE handlers (delta, tool_call, agent_*, plan, …).
 * Skipped when v2 protocol is enabled — v2 uses envelope → chatStore.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
import type { AgentStep } from '../components/AgentStepCard';
import { notify } from '../notifications/desktop';
import { normalizeAgentContentText } from '../utils/graphMarkers';
import { deriveShellExecutionState } from '../utils/shellOutput';
import { isTerminalDoneReason } from '../utils/terminalDone';
import { finalizeRunningTurns, interruptRunningTurns, resumeInterruptedTurns } from './chatStore';
import type { ChatMessage, ToolCallInfo } from './chatTypes';
import { logConsole } from './consoleStore';
import { clearPendingNeedsInput } from './needsInputStore';

export interface LegacyChatBridgeRefs {
    activeReplyRef: MutableRefObject<boolean>;
    activeTurnIdRef: MutableRefObject<string>;
}

export interface LegacyChatBridgeHandlers {
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setAbnormalTermination: (v: boolean) => void;
    setHasCheckpoint: (v: boolean) => void;
    setRecoveryMode: (v: 'exact' | 'soft' | 'none') => void;
    setIsResuming: (v: boolean) => void;
}

function formatShellOutput(result: Record<string, unknown>): string {
    const stdout = String(result.stdout ?? '').trim();
    const stderr = String(result.stderr ?? '').trim();
    const exitCode = result.exitCode;
    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stderr);
    if (exitCode != null && exitCode !== 0 && parts.length === 0) {
        parts.push(`exit code: ${exitCode}`);
    }
    return parts.join('\n').trim();
}

function upsertTurnAssistant(
    prev: ChatMessage[],
    refs: LegacyChatBridgeRefs,
    mutate: (msg: ChatMessage) => ChatMessage,
): ChatMessage[] {
    const turnId = refs.activeTurnIdRef.current;
    if (turnId) {
        for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'assistant' && prev[i].turnId === turnId) {
                const updated = [...prev];
                updated[i] = mutate(prev[i]);
                return updated;
            }
        }
        // Not found — inherit planSteps from the last assistant message with plan steps
        // to avoid losing plan data when a fresh placeholder is created due to state race.
        let lastPlanSteps: ChatMessage['planSteps'] | undefined;
        for (let j = prev.length - 1; j >= 0; j--) {
            if (prev[j].role === 'assistant' && prev[j].planSteps?.length) {
                lastPlanSteps = prev[j].planSteps;
                break;
            }
        }
        const fresh: ChatMessage = {
            role: 'assistant', content: '', _streaming: true, turnId,
            planSteps: lastPlanSteps,
        };
        return [...prev, mutate(fresh)];
    }
    for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'assistant') {
            const updated = [...prev];
            updated[i] = mutate(prev[i]);
            return updated;
        }
    }
    const fresh: ChatMessage = { role: 'assistant', content: '', _streaming: true };
    return [...prev, mutate(fresh)];
}

export function installLegacyChatBridge(
    v2Enabled: boolean,
    refs: LegacyChatBridgeRefs,
    handlers: LegacyChatBridgeHandlers,
): () => void {
    const { setMessages, setAbnormalTermination, setHasCheckpoint, setRecoveryMode, setIsResuming } = handlers;
    const upsert = (prev: ChatMessage[], mutate: (msg: ChatMessage) => ChatMessage) =>
        upsertTurnAssistant(prev, refs, mutate);

    const unsubs = [
        onPluginEvent('user_message_saved', (payload) => {
            if (v2Enabled) return;
            const msg = payload as {
                role: string;
                content: string;
                contextRefs?: { display: string; type?: string }[];
                images?: { url: string; mimeType?: string; name?: string }[];
            };
            setMessages((prev) => [...prev, {
                role: 'user' as const,
                content: msg.content,
                contextRefs: msg.contextRefs,
                images: msg.images,
            }]);
        }),
        onPluginEvent('delta', (p) => {
            if (v2Enabled) return;
            const { text } = p as { text: string };
            const cleaned = normalizeAgentContentText(text);
            if (!cleaned) return;
            logConsole('sse', 'delta', { text: cleaned.substring(0, 100) + (cleaned.length > 100 ? '...' : '') });
            setMessages((prev) => upsert(prev, (msg) => ({
                ...msg,
                content: (msg.content || '') + cleaned,
                _streaming: true,
            })));
        }),
        onPluginEvent('skills_activated', (payload) => {
            if (v2Enabled) return;
            const data = payload as {
                node?: string;
                items?: { id: string; version?: string; source?: string; scope?: string; priority?: number; tokens?: number }[];
            };
            const items = (data.items ?? []).filter((i) => i?.id);
            if (items.length === 0) return;
            const record = { node: data.node ?? 'UNKNOWN', skills: items, ts: Date.now() };
            setMessages((prev) =>
                upsert(prev, (msg) => ({
                    ...msg,
                    skillActivations: [...(msg.skillActivations ?? []), record],
                })),
            );
        }),
        onPluginEvent('server_backoff', () => {
            refs.activeReplyRef.current = false;
        }),
        onPluginEvent('conversation_running', (payload) => {
            const running = Boolean((payload as { running?: boolean }).running);
            refs.activeReplyRef.current = running;
            if (running) {
                setIsResuming(false);
            }
            if (!running) {
                refs.activeTurnIdRef.current = '';
                finalizeRunningTurns();
                setMessages((prev) => {
                    let changed = false;
                    const next = prev.map((msg) => {
                        if (msg.role !== 'assistant') return msg;
                        let msgChanged = false;
                        const agentSteps = msg.agentSteps?.map((s) => {
                            if (s.status !== 'running') return s;
                            msgChanged = true;
                            return { ...s, status: 'success' as const };
                        });
                        const planSteps = msg.planSteps?.map((s) => {
                            if (s.status !== 'running' && s.status !== 'in_progress') return s;
                            msgChanged = true;
                            return { ...s, status: 'success' as const };
                        });
                        if (!msgChanged) return msg;
                        changed = true;
                        return {
                            ...msg,
                            _streaming: false,
                            agentSteps,
                            planSteps,
                        };
                    });
                    return changed ? next : prev;
                });
            }
        }),
        onPluginEvent('done', (p) => {
            const data = p as { reason?: string };
            const reason = data.reason || 'final';
            if (v2Enabled) {
                if (isTerminalDoneReason(reason)) {
                    finalizeRunningTurns();
                }
                // Resume after askUser clears the banner; awaiting_user_input means paused again.
                setIsResuming(false);
                return;
            }
            logConsole('sse', 'done', data);
            const isFinal =
                reason === 'final' ||
                reason === 'failed' ||
                reason === 'stopped' ||
                reason === 'max_steps' ||
                reason === 'partial';
            if (isFinal) notify(reason === 'final' ? 'CodePilot completed' : 'CodePilot stopped', `Reason: ${reason}`);
            if (!isFinal) return;
            if (!refs.activeReplyRef.current) return;
            setMessages((prev) => upsert(prev, (msg) => ({
                ...msg,
                _streaming: false,
                agentSteps: msg.agentSteps?.map((s) => s.status === 'running' ? { ...s, status: 'success' as const } : s),
                // Normalize plan steps: running/in_progress → success; completed → success
                planSteps: msg.planSteps?.map((s) => ({
                    ...s,
                    status:
                        s.status === 'failed' || s.status === 'error'
                            ? 'failed'
                            : s.status === 'running' || s.status === 'in_progress' || s.status === 'completed'
                                ? 'success'
                                : s.status,
                })),
            })));
            refs.activeReplyRef.current = false;
            refs.activeTurnIdRef.current = '';
            setAbnormalTermination(false);
            setHasCheckpoint(false);
            setRecoveryMode('none');
            setIsResuming(false);
            sendToPlugin('list_sessions', {}).catch(() => undefined);
        }),
        onPluginEvent('tool_call', (p) => {
            if (v2Enabled) return;
            const tc = p as { id?: string; toolCallId?: string; name?: string; tool?: string; args: unknown };
            logConsole('tool', 'tool_call', tc);
            const toolCallInfo: ToolCallInfo = {
                id: tc.id || tc.toolCallId || '',
                name: tc.name || tc.tool || 'unknown',
                args: (tc.args || {}) as Record<string, unknown>,
                status: 'running',
            };
            setMessages((msgs) => upsert(msgs, (msg) => ({
                ...msg,
                toolCalls: [...(msg.toolCalls || []), toolCallInfo],
                _streaming: true,
            })));
        }),
        onPluginEvent('tool_result_ack', (p) => {
            if (v2Enabled) return;
            const ack = p as { toolCallId?: string; ok?: boolean; result?: Record<string, unknown> };
            const ackId = ack.toolCallId || '';
            if (!ackId) return;
            const shellSucceeded = (result: Record<string, unknown> | undefined): boolean => {
                if (!result) return true;
                if (result.timedOut === true) return false;
                const code = typeof result.exitCode === 'number' ? result.exitCode : -1;
                return code === 0;
            };
            setMessages((msgs) => {
                let assistantIdx = -1;
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].role === 'assistant' && msgs[i].toolCalls?.some((tc) => tc.id === ackId)) {
                        assistantIdx = i;
                        break;
                    }
                }
                if (assistantIdx < 0) return msgs;
                const updated = [...msgs];
                const existing = updated[assistantIdx];
                const matchedTool = existing.toolCalls?.find((tc) => tc.id === ackId);
                const toolOk = Boolean(ack.ok) && shellSucceeded(ack.result);
                const shellOut =
                    matchedTool?.name === 'shell.exec' && ack.result
                        ? formatShellOutput(ack.result)
                        : undefined;
                const nextStatus = toolOk ? 'success' : 'error';
                const executionState =
                    matchedTool?.name === 'shell.exec'
                        ? deriveShellExecutionState(nextStatus, ack.result)
                        : nextStatus;
                updated[assistantIdx] = {
                    ...existing,
                    toolCalls: existing.toolCalls?.map((tc) =>
                        tc.id === ackId
                            ? {
                                ...tc,
                                status: nextStatus,
                                result: ack.result ?? tc.result,
                                executionState,
                            }
                            : tc),
                    agentSteps: shellOut
                        ? existing.agentSteps?.map((step, idx, arr) => {
                            const isLastRunning =
                                step.type === 'running' &&
                                idx === arr.length - 1 &&
                                step.status === 'running';
                            if (!isLastRunning) return step;
                            return {
                                ...step,
                                status: toolOk ? ('success' as const) : ('error' as const),
                                detail: {
                                    ...step.detail,
                                    command:
                                        (matchedTool?.args?.command as string) ||
                                        step.detail?.command,
                                    output: shellOut,
                                },
                            };
                        })
                        : existing.agentSteps,
                };
                return updated;
            });
        }),
        onPluginEvent('risk_notice', (p) => {
            const rn = p as { level: string; message: string; filesPaths: string[] };
            if (refs.activeReplyRef.current) {
                setMessages((msgs) => upsert(msgs, (msg) => ({
                    ...msg,
                    riskNotice: rn,
                    _streaming: true,
                })));
                return;
            }
            setMessages((msgs) => [...msgs, { role: 'system', content: '', riskNotice: rn }]);
        }),
        onPluginEvent('needs_input', (p) => {
            notify('CodePilot needs input', 'The agent is waiting for your response.');
            const niMsg = p as ChatMessage['needsInput'];
            if (refs.activeReplyRef.current) {
                setMessages((msgs) => upsert(msgs, (msg) => ({ ...msg, needsInput: niMsg, _streaming: true })));
                return;
            }
            setMessages((msgs) => [...msgs, { role: 'system', content: '', needsInput: niMsg }]);
        }),
        onPluginEvent('error', (p) => {
            const err = p as { code: number; message: string };
            logConsole('error', 'error', err);
            clearPendingNeedsInput();
            if (err.code === 42901) {
                return;
            }
            notify('CodePilot', err.message || 'The current task failed.');
            if (refs.activeReplyRef.current) {
                setMessages((msgs) => upsert(msgs, (msg) => ({
                    ...msg,
                    content: (msg.content || '') + `\n\n❌ **Error**: ${err.message}`,
                    _streaming: true,
                })));
                return;
            }
            setMessages((msgs) => [...msgs, { role: 'system', content: `Error: ${err.message}` }]);
        }),
        onPluginEvent('action_start', (p) => {
            const data = p as { action: string; display: string; instruction: string };
            if (refs.activeReplyRef.current) return;
            setMessages((prev) => [...prev, { role: 'user' as const, content: `**${data.display}**\n${data.instruction}` }]);
        }),
        onPluginEvent('action_done', () => {
            if (refs.activeReplyRef.current) return;
            setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last._streaming) {
                    return [...prev.slice(0, -1), { ...last, _streaming: false }];
                }
                return prev;
            });
        }),
        onPluginEvent('session_interrupted', (p) => {
            const data = p as {
                sessionId: string;
                hasCheckpoint: boolean;
                recoveryMode?: 'exact' | 'soft' | 'none';
            };
            refs.activeReplyRef.current = false;
            refs.activeTurnIdRef.current = '';
            setAbnormalTermination(true);
            setHasCheckpoint(data.hasCheckpoint);
            const mode = data.recoveryMode;
            if (mode === 'exact' || mode === 'soft') {
                setRecoveryMode(mode);
            } else {
                setRecoveryMode(data.hasCheckpoint ? 'soft' : 'none');
            }
            setIsResuming(false);
            // Mark running turn as interrupted in v2 store
            interruptRunningTurns();
            setMessages((prev) => {
                let lastAssistantIdx = -1;
                for (let i = prev.length - 1; i >= 0; i--) {
                    if (prev[i].role === 'assistant') { lastAssistantIdx = i; break; }
                }
                if (lastAssistantIdx >= 0 && prev[lastAssistantIdx]._streaming) {
                    const updated = [...prev];
                    updated[lastAssistantIdx] = { ...prev[lastAssistantIdx], _streaming: false };
                    return updated;
                }
                return prev;
            });
        }),
        onPluginEvent('session_resuming', () => {
            refs.activeReplyRef.current = true;
            setAbnormalTermination(false);
            setIsResuming(true);
            // Resume interrupted turn in v2 store
            resumeInterruptedTurns();
        }),
        onPluginEvent('agent_thinking', (payload) => {
            if (v2Enabled) return;
            const data = payload as { text?: string };
            const step: AgentStep = { type: 'thinking', content: data.text || '思考中...', status: 'running' };
            setMessages((prev) => upsert(prev, (msg) => ({
                ...msg,
                agentSteps: [...(msg.agentSteps || []), step],
                _streaming: true,
            })));
        }),
        onPluginEvent('agent_reading', (payload) => {
            if (v2Enabled) return;
            const data = payload as { summary?: string; files?: { path: string; op?: string }[] };
            const readingStep: AgentStep = {
                type: 'reading',
                content: data.summary || '读取文件',
                status: 'success',
                detail: { files: (data.files || []).map((f) => ({ path: f.path, op: f.op })), summary: data.summary },
            };
            setMessages((prev) => upsert(prev, (msg) => {
                const steps = [...(msg.agentSteps || [])];
                const last = steps[steps.length - 1];
                if (last?.type === 'thinking' && last.status === 'running') {
                    steps[steps.length - 1] = { ...last, status: 'success' };
                }
                return { ...msg, agentSteps: [...steps, readingStep], _streaming: true };
            }));
        }),
        onPluginEvent('agent_writing', (payload) => {
            if (v2Enabled) return;
            const data = payload as { text?: string; files?: { path: string; op?: string; lineCount?: number; preview?: string }[] };
            const writingStep: AgentStep = {
                type: 'writing',
                content: data.text || '修改文件',
                status: 'running',
                detail: { files: data.files || [] },
            };
            setMessages((prev) => upsert(prev, (msg) => {
                const steps = [...(msg.agentSteps || [])];
                const last = steps[steps.length - 1];
                if (last?.type === 'thinking' && last.status === 'running') {
                    steps[steps.length - 1] = { ...last, status: 'success' };
                }
                return { ...msg, agentSteps: [...steps, writingStep], _streaming: true };
            }));
        }),
        onPluginEvent('agent_running', (payload) => {
            if (v2Enabled) return;
            const data = payload as { text?: string; command?: string; output?: string };
            const cmd = data.command?.trim() || '';
            const runningStep: AgentStep = {
                type: 'running',
                content: cmd || data.text || '运行命令',
                status: 'running',
                detail: { command: cmd || data.command, output: data.output },
            };
            setMessages((prev) => upsert(prev, (msg) => {
                const steps = [...(msg.agentSteps || [])];
                const last = steps[steps.length - 1];
                if (last?.type === 'writing' && last.status === 'running') {
                    steps[steps.length - 1] = { ...last, status: 'success' };
                }
                return { ...msg, agentSteps: [...steps, runningStep], _streaming: true };
            }));
        }),
        onPluginEvent('user_plan', (payload) => {
            if (v2Enabled) return;
            const data = payload as { steps?: { id: string; title: string; status?: string }[] };
            if (!data.steps?.length) return;
            setMessages((prev) => upsert(prev, (msg) => ({
                ...msg,
                planSteps: data.steps!.map((s) => ({ id: s.id, title: s.title, status: s.status || 'pending' })),
                _streaming: true,
            })));
        }),
        onPluginEvent('user_plan_progress', (payload) => {
            if (v2Enabled) return;
            const data = payload as { stepId?: string; stepIndex?: number; status?: string; completedSteps?: number };
            setMessages((prev) => upsert(prev, (msg) => {
                if (!msg.planSteps?.length) return { ...msg };
                const mapStatus = (raw: string | undefined) => {
                    const s = (raw || 'in_progress').toLowerCase();
                    if (s === 'failed' || s === 'error') return 'failed';
                    if (s === 'completed' || s === 'done' || s === 'success') return 'success';
                    if (s === 'in_progress' || s === 'running') return 'running';
                    return raw || 'in_progress';
                };
                const updatedSteps = msg.planSteps.map((step, idx) => {
                    if (data.stepId && step.id === data.stepId) return { ...step, status: mapStatus(data.status) };
                    if (data.stepIndex !== undefined && idx === data.stepIndex) return { ...step, status: mapStatus(data.status) };
                    return step;
                });
                if (data.completedSteps !== undefined && data.completedSteps > 0) {
                    for (let i = 0; i < data.completedSteps && i < updatedSteps.length; i++) {
                        if (updatedSteps[i].status === 'pending' || updatedSteps[i].status === 'in_progress') {
                            updatedSteps[i] = { ...updatedSteps[i], status: 'success' };
                        }
                    }
                }
                return { ...msg, planSteps: updatedSteps, _streaming: true };
            }));
        }),
    ];
    return () => unsubs.forEach((u) => u());
}
