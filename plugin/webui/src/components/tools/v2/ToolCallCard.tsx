import { useState } from 'react';
import { sendToPlugin } from '../../../bridge';
import type { StepNode } from '../../../state/events';
import { ToolArgsView } from './ToolArgsView';
import { ToolResultView } from './ToolResultView';
import { isExternalMcpTool, parseMcpTool } from './mcpUtils';
import type { ToolResultPayload } from './types';

/**
 * v2 tool call card. Renders a single tool step from the v2 envelope store.
 *
 * Layout:
 *   [ status • name • one-line summary • duration • copy/rerun ]
 *   [ ▶ Arguments (collapsed by default) ]
 *   [ ▼ Result (auto-expanded for short, collapsed for very long) ]
 */
export function ToolCallCard({ step }: { step: StepNode }) {
    const call = step.toolCall;
    const result = step.toolResult;
    const [argsOpen, setArgsOpen] = useState(false);
    const initialResultOpen = shouldAutoOpenResult(result?.result as ToolResultPayload | undefined);
    const [resultOpen, setResultOpen] = useState(initialResultOpen);

    if (!call) return null;

    const mcp = parseMcpTool(call.tool);
    const duration = step.endedAt ? `${step.endedAt - step.startedAt}ms` : 'running…';
    const statusIcon = step.status === 'running' ? '⏳'
        : step.status === 'success' ? '✓'
        : step.status === 'error' ? '✗' : '·';

    return (
        <div className={`tool-card tool-status-${step.status}${mcp ? ' tool-card-mcp' : ''}`}>
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
                <code className="tool-name">{call.tool}</code>
                {isExternalMcpTool(call.tool) && !mcp && (
                    <span className="tool-mcp-source muted" title="MCP tool">MCP</span>
                )}
                <span className="tool-summary">{summarize(call.tool, call.args)}</span>
                <span className="tool-duration">{duration}</span>
                <button
                    type="button"
                    className="tool-action"
                    onClick={() => copyToClipboard(JSON.stringify(call.args, null, 2))}
                    title="Copy arguments as JSON"
                >
                    Copy args
                </button>
                {step.status !== 'running' && (
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
                            : <div className="tool-progress-placeholder">…executing</div>
                    )}
                </div>
            )}
        </div>
    );
}

function copyToClipboard(text: string) {
    try {
        navigator.clipboard?.writeText(text).catch(() => undefined);
    } catch {
        // older runtimes — silently no-op
    }
}

/**
 * Produce a short one-line summary for the header so users don't need to expand
 * Arguments to understand what the tool is doing.
 */
function summarize(tool: string, rawArgs: unknown): string {
    const a = (rawArgs && typeof rawArgs === 'object') ? (rawArgs as Record<string, unknown>) : {};
    const s = (v: unknown) => typeof v === 'string' ? v : '';
    switch (true) {
        case tool === 'fs.read' || tool === 'fs.outline': {
            const p = s(a.path);
            const r = a.range as { startLine?: number; endLine?: number } | undefined;
            return r?.startLine ? `${p}:${r.startLine}-${r.endLine ?? ''}` : p;
        }
        case tool.startsWith('fs.write') || tool === 'fs.create' || tool === 'fs.replace'
            || tool === 'fs.delete' || tool === 'fs.move' || tool === 'fs.applyPatch':
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
            const args = Object.keys(a).slice(0, 2).map((k) => `${k}=${shortenValue(a[k])}`).join(' ');
            return parsed
                ? `${parsed.serverId}/${parsed.toolName}${args ? ` · ${args}` : ''}`
                : args || tool;
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
        // Don't auto-open very large or content-heavy renderers
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
