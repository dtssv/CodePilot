import { useState } from 'react';
import { sendToPlugin } from '../../../bridge';
import type { StepNode } from '../../../state/events';
import type { ToolExecutionState } from '../../../state/chatTypes';
import { ToolArgsView } from './ToolArgsView';
import { ToolResultView } from './ToolResultView';
import { isExternalMcpTool, parseMcpTool } from './mcpUtils';
import type { ToolResultPayload } from './types';
import { summarizeApplyPatch } from '../../../utils/graphMarkers';
import { ShellAskBar } from '../../shell/ShellAskBar';
import { ShellCommandHeader, resolveShellCwd } from '../../shell/ShellCommandHeader';
import { ShellOutputPreview } from '../../shell/ShellOutputPreview';
import { useShellAskForStep } from '../../../state/shellAskStore';
import { deriveShellExecutionState } from '../../../utils/shellOutput';

/**
 * v2 tool call card. Renders a single tool step from the v2 envelope store.
 */
export function ToolCallCard({ step }: { step: StepNode }) {
    const shellAsk = useShellAskForStep(step.stepId);
    const call = step.toolCall;
    const result = step.toolResult;
    const [argsOpen, setArgsOpen] = useState(false);
    const shellPayload = result?.result as ToolResultPayload | undefined;
    const initialResultOpen = shouldAutoOpenResult(shellPayload);
    const [resultOpen, setResultOpen] = useState(initialResultOpen);

    if (!call) return null;

    const isShell = call.tool === 'shell.exec' || call.tool === 'shell.session';
    const args = (call.args && typeof call.args === 'object')
        ? (call.args as Record<string, unknown>)
        : {};
    const shellRecord = isShell ? shellResultAsRecord(shellPayload, args) : undefined;
    const stepStatus = step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'success';
    const executionState: ToolExecutionState | undefined =
        step.executionState
        ?? (isShell ? deriveShellExecutionState(stepStatus, shellRecord) : stepStatus);
    const terminal = executionState && executionState !== 'running';

    const mcp = parseMcpTool(call.tool);
    const duration = step.endedAt ? `${step.endedAt - step.startedAt}ms` : 'running…';
    const statusIcon = executionState === 'denied' ? '⊘'
        : executionState === 'skipped' ? '⊘'
        : step.status === 'running' ? '⏳'
        : step.status === 'success' ? '✓'
        : step.status === 'error' ? '✗' : '·';
    const statusLabel =
        executionState === 'denied' ? '已拒绝'
        : executionState === 'skipped' ? '已跳过'
        : null;

    const shellCmd = isShell ? String(args.command ?? '') : '';
    const shellCwd = isShell ? resolveShellCwd(args, shellRecord) : '';

    return (
        <div className={`tool-card tool-status-${executionState ?? step.status}${mcp ? ' tool-card-mcp' : ''}`}>
            {mcp && (
                <div className="tool-mcp-banner" role="note">
                    <span className="tool-mcp-badge">MCP</span>
                    <span className="tool-mcp-server">{mcp.serverId}</span>
                    <span className="tool-mcp-sep">·</span>
                    <code className="tool-mcp-tool">{mcp.toolName}</code>
                    <span className="tool-mcp-hint muted">External tool — review args</span>
                </div>
            )}
            <div className="tool-card-header">
                <span className="tool-icon" aria-label={step.status}>{statusIcon}</span>
                {isShell && shellCmd ? (
                    <ShellCommandHeader command={shellCmd} cwd={shellCwd} />
                ) : (
                    <>
                        <code className="tool-name">{call.tool}</code>
                        {isExternalMcpTool(call.tool) && !mcp && (
                            <span className="tool-mcp-source muted" title="MCP tool">MCP</span>
                        )}
                        <span className="tool-summary">{summarize(call.tool, call.args)}</span>
                    </>
                )}
                {statusLabel ? <span className="tool-exec-badge muted">{statusLabel}</span> : null}
                <span className="tool-duration">{duration}</span>
                <button
                    type="button"
                    className="tool-action"
                    onClick={() => copyToClipboard(JSON.stringify(call.args, null, 2))}
                    title="Copy arguments as JSON"
                >
                    Copy args
                </button>
                {step.status !== 'running' && !terminal && (
                    <button
                        type="button"
                        className="tool-action"
                        onClick={() => sendToPlugin('tool.rerun', {
                            stepId: step.stepId,
                            tool: call.tool,
                            args: call.args,
                        }).catch(() => undefined)}
                        title="Re-run this tool locally (does not feed back to LLM)"
                    >
                        Rerun
                    </button>
                )}
            </div>
            {(call.tool === 'shell.exec' || call.tool === 'shell.session') && shellAsk && (
                <ShellAskBar ask={shellAsk} />
            )}
            {isShell && shellRecord && formatHasOutput(shellRecord) && (
                <ShellOutputPreview result={shellRecord} className="tool-shell-output-inline" />
            )}
            {isShell && terminal && executionState === 'denied' && !formatHasOutput(shellRecord) && (
                <div className="tool-call-shell-state muted">命令未执行（用户拒绝）</div>
            )}
            {isShell && terminal && executionState === 'skipped' && !formatHasOutput(shellRecord) && (
                <div className="tool-call-shell-state muted">命令未执行（用户跳过）</div>
            )}

            <div className="tool-card-section">
                <button
                    type="button"
                    className="tool-section-toggle"
                    onClick={() => setArgsOpen((v) => !v)}
                >
                    {argsOpen ? '▼' : '▶'} Arguments
                </button>
                {argsOpen && <ToolArgsView args={call.args} />}
            </div>

            {(result || step.status === 'running') && (
                <div className="tool-card-section">
                    <button
                        type="button"
                        className="tool-section-toggle"
                        onClick={() => setResultOpen((v) => !v)}
                    >
                        {resultOpen ? '▼' : '▶'} Result
                    </button>
                    {resultOpen && (
                        result
                            ? <ToolResultView payload={result.result as ToolResultPayload} ok={result.ok} />
                            : (
                                <div className="tool-progress-placeholder shell-running-hint" role="status">
                                    <span className="tool-call-spinner" /> 正在执行命令…
                                    {isShell && (
                                        <pre className="shell-cmd-inline">$ {summarize(call.tool, call.args)}</pre>
                                    )}
                                </div>
                            )
                    )}
                </div>
            )}
        </div>
    );
}

function shellResultAsRecord(
    payload: ToolResultPayload | undefined,
    args: Record<string, unknown>,
): Record<string, unknown> | undefined {
    if (!payload) return undefined;
    if (payload.kind === 'shell') {
        return {
            command: payload.command,
            cwd: payload.cwd,
            stdout: payload.stdout,
            stderr: payload.stderr,
            exitCode: payload.exitCode,
            durationMs: payload.durationMs,
            timedOut: payload.timedOut,
        };
    }
    if (typeof payload === 'object') return payload as Record<string, unknown>;
    return args;
}

function formatHasOutput(r?: Record<string, unknown>): boolean {
    if (!r) return false;
    return Boolean(String(r.stdout ?? '').trim() || String(r.stderr ?? '').trim());
}

function copyToClipboard(text: string) {
    try {
        navigator.clipboard?.writeText(text).catch(() => undefined);
    } catch {
        // older runtimes — silently no-op
    }
}

function summarize(tool: string, rawArgs: unknown): string {
    const a = (rawArgs && typeof rawArgs === 'object') ? (rawArgs as Record<string, unknown>) : {};
    const s = (v: unknown) => typeof v === 'string' ? v : '';
    switch (true) {
        case tool === 'fs.read' || tool === 'fs.outline': {
            const p = s(a.path);
            const r = a.range as { startLine?: number; endLine?: number } | undefined;
            return r?.startLine ? `${p}:${r.startLine}-${r.endLine ?? ''}` : p;
        }
        case tool === 'fs.applyPatch': {
            const d = summarizeApplyPatch(a);
            return d.detail ? `${d.description} · ${d.detail}` : d.description;
        }
        case tool.startsWith('fs.write') || tool === 'fs.create' || tool === 'fs.replace'
            || tool === 'fs.delete' || tool === 'fs.move':
            return s(a.path) || 'multiple files';
        case tool === 'fs.grep' || tool === 'fs.search':
            return `"${s(a.pattern)}"${a.path ? ` in ${s(a.path)}` : ''}`;
        case tool === 'shell.exec' || tool === 'shell.session':
            return s(a.command);
        case tool === 'ide.openFile':
            return s(a.path);
        case tool === 'ide.diagnostics':
            return s(a.path) || 'workspace';
        case tool.startsWith('mcp.'): {
            const parsed = parseMcpTool(tool);
            const argParts = Object.keys(a).slice(0, 2).map((k) => `${k}=${shortenValue(a[k])}`).join(' ');
            return parsed
                ? `${parsed.serverId}/${parsed.toolName}${argParts ? ` · ${argParts}` : ''}`
                : argParts || tool;
        }
        default:
            return Object.keys(a).slice(0, 3).map((k) => `${k}=${shortenValue(a[k])}`).join(' ');
    }
}

function shortenValue(v: unknown): string {
    if (v == null) return 'null';
    if (typeof v === 'string') return v.length > 30 ? `${v.slice(0, 30)}…` : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
        const s = JSON.stringify(v);
        return s.length > 30 ? `${s.slice(0, 30)}…` : s;
    } catch {
        return String(v);
    }
}

function shouldAutoOpenResult(p: ToolResultPayload | undefined): boolean {
    if (!p) return true;
    switch (p.kind) {
        case 'fs.read':
            return (p.content?.length ?? 0) < 4000;
        case 'shell':
            return ((p.stdout?.length ?? 0) + (p.stderr?.length ?? 0)) < 8000;
        case 'grep':
            return p.matches.length <= 20;
        default:
            return true;
    }
}
