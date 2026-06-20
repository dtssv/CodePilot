import { useEffect, useState } from 'react';
import { ShellAskBar } from './shell/ShellAskBar';
import { ShellCommandHeader, resolveShellCwd } from './shell/ShellCommandHeader';
import { ShellOutputPreview } from './shell/ShellOutputPreview';
import { useShellAskForStep } from '../state/shellAskStore';
import type { ToolExecutionState } from '../state/chatTypes';
import { deriveShellExecutionState } from '../utils/shellOutput';
import { extractPatchItems, summarizeApplyPatch } from '../utils/graphMarkers';
import { normalizeToolArgs } from '../utils/toolArgs';

export interface ToolCallInfo {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status?: 'running' | 'success' | 'error';
    executionState?: ToolExecutionState;
    result?: Record<string, unknown>;
}

const CATEGORY_COLORS: Record<string, string> = {
    read: '#4ec9b0',
    write: '#d7ba7d',
    search: '#569cd6',
    ide: '#c586c0',
    shell: '#ce9178',
    code: '#4fc1ff',
    plan: '#b5cea8',
    notepad: '#dcdcaa',
    mcp: '#9cdcfe',
    other: '#9d9d9d',
};

function getToolCategory(name: string): string {
    if (name.startsWith('fs.read') || name.startsWith('fs.list') || name.startsWith('fs.outline')) return 'read';
    if (name.startsWith('fs.write') || name.startsWith('fs.create') || name.startsWith('fs.replace') ||
        name.startsWith('fs.delete') || name.startsWith('fs.move') || name.startsWith('fs.applyPatch')) return 'write';
    if (name.startsWith('fs.search') || name.startsWith('fs.grep') || name.startsWith('code.symbol') ||
        name.startsWith('code.usages') || name.startsWith('codebase') || name.startsWith('rag.')) return 'search';
    if (name.startsWith('ide.')) return 'ide';
    if (name.startsWith('shell.')) return 'shell';
    if (name.startsWith('code.')) return 'code';
    if (name.startsWith('plan.')) return 'plan';
    if (name.startsWith('notepad.')) return 'notepad';
    if (name.startsWith('mcp.')) return 'mcp';
    if (name.startsWith('gather.')) return 'read';
    return 'other';
}

const toolIcons: Record<string, string> = {
    'fs.read': '📖', 'fs.list': '📂', 'fs.search': '🔍', 'fs.grep': '🔎',
    'fs.outline': '🗺️', 'fs.create': '✨', 'fs.write': '📝', 'fs.replace': '🔄',
    'fs.delete': '🗑️', 'fs.move': '📦', 'fs.applyPatch': '🩹',
    'ide.openFile': '📂', 'ide.diagnostics': '🩺', 'ide.applyPatch': '🩹',
    'ide.shadowValidate': '🛡️', 'shell.exec': '⌨️', 'shell.session': '💻',
    'code.outline': '🗺️', 'code.symbol': '🔣', 'code.usages': '🔗',
    'plan.show': '📋', 'plan.update': '📋',
    'notepad.write': '📓', 'notepad.read': '📓',
    'rag.search': '🧠',
    'gather.execute': '📥',
};

const TOOL_VERBS: Record<string, string> = {
    'fs.read': '读取', 'fs.list': '列出', 'fs.search': '搜索', 'fs.grep': '搜索',
    'fs.outline': '大纲', 'fs.create': '创建', 'fs.write': '写入', 'fs.replace': '替换',
    'fs.delete': '删除', 'fs.move': '移动', 'fs.applyPatch': '补丁',
    'ide.openFile': '打开', 'ide.diagnostics': '诊断', 'ide.applyPatch': '补丁',
    'ide.shadowValidate': '验证', 'shell.exec': '执行', 'shell.session': '终端',
    'code.outline': '大纲', 'code.symbol': '符号', 'code.usages': '引用',
    'plan.show': '计划', 'plan.update': '计划',
    'notepad.write': '笔记', 'notepad.read': '笔记',
    'rag.search': '语义搜索',
    'gather.execute': '收集',
};

const WRITE_TOOLS = new Set([
    'fs.write', 'fs.create', 'fs.replace', 'fs.delete', 'fs.move', 'fs.applyPatch',
]);

const READ_TOOLS = new Set([
    'fs.read', 'fs.list', 'fs.search', 'fs.grep', 'fs.outline',
]);

/** Shorten a path for compact display — keep last N segments + show full path on hover. */
function shortPath(p: string, _maxSegments = 2): string {
    if (!p) return '';
    return p.replace(/\\/g, '/').split('/').pop() || p;
}

function lineCount(s: string | undefined): number {
    if (!s) return 0;
    return s.split('\n').length;
}

/** Represents a single diff line for color-coded display. */
interface DiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
}

/**
 * Build diff lines for write/create/replace operations.
 * - fs.create / fs.write: all lines are green (add)
 * - fs.replace with search+replace: search lines are red (remove), replace lines are green (add)
 * - fs.replace with only newContent: all lines are green (add)
 * - fs.delete: a single red banner line
 */
function buildDiffLines(name: string, args: Record<string, unknown>): DiffLine[] {
    const lines: DiffLine[] = [];

    if (name === 'fs.delete') {
        lines.push({ type: 'remove', content: '// 文件已删除' });
        return lines;
    }

    if (name === 'fs.replace') {
        const search = (args.search as string) || '';
        const replace = (args.replace as string) || (args.newContent as string) || (args.content as string) || '';

        if (search) {
            // Show removed lines (red) then added lines (green)
            for (const line of search.split('\n')) {
                lines.push({ type: 'remove', content: line });
            }
            for (const line of replace.split('\n')) {
                lines.push({ type: 'add', content: line });
            }
        } else {
            // No search text, treat as full content write (all green)
            const content = replace || (args.newContent as string) || (args.content as string) || '';
            for (const line of content.split('\n')) {
                lines.push({ type: 'add', content: line });
            }
        }
        return lines;
    }

    // fs.create / fs.write: all green
    const content = (args.newContent as string) || (args.content as string) || '';
    if (!content) return lines;
    for (const line of content.split('\n')) {
        lines.push({ type: 'add', content: line });
    }
    return lines;
}

function buildToolMeta(name: string, args: Record<string, unknown>): { description: string; detail: string; fullPath?: string } {
    const path = (args.path as string) || '';
    const content = (args.newContent as string) || (args.content as string) || (args.replace as string) || '';
    const search = (args.search as string) || '';
    const lines = lineCount(content);
    const sp = shortPath(path);
    const startLine = args.startLine as number | undefined;
    const endLine = args.endLine as number | undefined;

    switch (name) {
        case 'fs.read': {
            const range = startLine && endLine ? ':' + startLine + '-' + endLine : '';
            return { description: sp + range, detail: startLine && endLine ? (endLine - startLine + 1) + ' 行' : '', fullPath: path || undefined };
        }
        case 'fs.list':
            return { description: sp || '.', detail: '', fullPath: path || undefined };
        case 'fs.search':
        case 'fs.grep': {
            const q = (args.query as string) || '';
            return { description: q.length > 40 ? q.substring(0, 40) + '...' : q, detail: sp ? sp : '', fullPath: path || undefined };
        }
        case 'fs.outline':
            return { description: sp, detail: '', fullPath: path || undefined };
        case 'fs.create':
            return { description: sp, detail: lines > 0 ? lines + ' 行' : '', fullPath: path || undefined };
        case 'fs.write':
            return { description: sp, detail: lines > 0 ? lines + ' 行' : '', fullPath: path || undefined };
        case 'fs.replace':
            return { description: sp, detail: lines > 0 ? lines + ' 行' : search ? '文本替换' : '', fullPath: path || undefined };
        case 'fs.delete':
            return { description: sp, detail: '', fullPath: path || undefined };
        case 'fs.move':
            return { description: sp + ' → ' + shortPath((args.destination as string) || (args.to as string) || ''), detail: '', fullPath: path || undefined };
        case 'fs.applyPatch':
            return { ...summarizeApplyPatch(args), fullPath: path || undefined };
        case 'ide.openFile': {
            const line = args.line as number | undefined;
            return { description: sp, detail: line ? ':' + line : '', fullPath: path || undefined };
        }
        case 'ide.diagnostics':
            return { description: sp || '项目', detail: '', fullPath: path || undefined };
        case 'ide.applyPatch':
            return { description: '应用补丁', detail: '' };
        case 'ide.shadowValidate': {
            const vType = (args.validateType as string) || '';
            return { description: vType === 'compile' ? '编译检查' : vType || '验证', detail: '' };
        }
        case 'shell.exec': {
            const cmd = (args.command as string) || '';
            return { description: cmd || 'shell', detail: '' };
        }
        case 'shell.session':
            return { description: (args.action as string) || 'exec', detail: '' };
        case 'code.outline':
            return { description: sp, detail: '', fullPath: path || undefined };
        case 'code.symbol':
            return { description: (args.query as string) || '', detail: sp ? sp : '', fullPath: path || undefined };
        case 'code.usages':
            return { description: (args.symbol as string) || '', detail: sp ? sp : '', fullPath: path || undefined };
        case 'plan.show':
        case 'plan.update':
            return { description: '任务计划', detail: '' };
        case 'notepad.write':
        case 'notepad.read':
            return { description: (args.name as string) || 'default', detail: '' };
        case 'rag.search': {
            const q = (args.query as string) || '';
            const topK = args.topK as number | undefined;
            return { description: q.length > 40 ? q.substring(0, 40) + '...' : q, detail: topK ? 'top-' + topK : '' };
        }
        case 'gather.execute': {
            const requests = args.requests as { id?: string; kind?: string; args?: Record<string, unknown> }[] | undefined;
            if (!requests || requests.length === 0) {
                return { description: '无请求', detail: '' };
            }
            const firstPath = shortPath(((requests[0]?.args as Record<string, unknown>)?.path as string) || '');
            const fileCount = requests.length;
            return {
                description: firstPath + (fileCount > 1 ? ` +${fileCount - 1}` : ''),
                detail: fileCount + ' 个文件',
            };
        }
        default: {
            if (name.startsWith('mcp.')) {
                const parts = name.split('.');
                return { description: parts.slice(2).join('.'), detail: '' };
            }
            return { description: name, detail: '' };
        }
    }
}

/** Read result content snippet. */
function readResultSnippet(
    result: Record<string, unknown> | undefined,
    maxLines = 8,
): string | null {
    if (!result) return null;
    const raw = (result.content as string) || '';
    if (!raw) return null;
    const lines = raw.split('\n');
    if (lines.length === 0) return null;
    const preview = lines.slice(0, maxLines).join('\n');
    const truncated = lines.length > maxLines;
    return truncated ? preview + '\n...' : preview;
}

/** Render color-coded diff lines. */
function DiffPreview({ diffLines, maxLines = 50 }: { diffLines: DiffLine[]; maxLines?: number }) {
    const visibleLines = diffLines.slice(0, maxLines);
    const truncated = diffLines.length > maxLines;
    return (
        <div className="tool-call-diff">
            <table className="tool-call-diff-table">
                <tbody>
                    {visibleLines.map((line, i) => (
                        <tr key={i} className={'tool-call-diff-line tool-call-diff-' + line.type}>
                            <td className="tool-call-diff-gutter">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</td>
                            <td className="tool-call-diff-content"><pre>{line.content}</pre></td>
                        </tr>
                    ))}
                    {truncated && (
                        <tr className="tool-call-diff-line">
                            <td className="tool-call-diff-gutter"> </td>
                            <td className="tool-call-diff-content tool-call-diff-ellipsis">... 还有 {diffLines.length - maxLines} 行</td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

export function ToolCallCard({ toolCall }: { toolCall: ToolCallInfo }) {
    const initialStatus = toolCall.status
        ?? (toolCall.result || toolCall.executionState ? 'success' : 'running');
    const [status, setStatus] = useState<'running' | 'success' | 'error'>(initialStatus);
    const [expanded, setExpanded] = useState(false);
    const shellAsk = useShellAskForStep(toolCall.id);

    useEffect(() => {
        if (toolCall.status && toolCall.status !== status) {
            setStatus(toolCall.status);
        }
    }, [toolCall.status]);

    // Resolve effective tool name for fs.applyPatch based on op field
    const rawArgs = normalizeToolArgs(toolCall.args);
    const op = (rawArgs.op as string) || '';
    const patches = toolCall.name === 'fs.applyPatch' ? extractPatchItems(rawArgs) : [];
    const hasMultiplePatches = patches.length > 1;

    // ★ gather.execute: extract sub-requests for inline display
    const isGatherExecute = toolCall.name === 'gather.execute';
    const gatherRequests = isGatherExecute
        ? (rawArgs.requests as { id?: string; kind?: string; args?: Record<string, unknown> }[] | undefined) || []
        : [];

    const applyPatchDisplay =
        toolCall.name === 'fs.applyPatch' ? summarizeApplyPatch(rawArgs) : null;

    // For single patch, resolve effective name based on op
    const effectiveName =
        toolCall.name === 'fs.applyPatch' && !hasMultiplePatches && op
            ? op === 'create'
                ? 'fs.create'
                : op === 'delete'
                  ? 'fs.delete'
                  : op === 'replace'
                    ? 'fs.replace'
                    : toolCall.name
            : toolCall.name;

    const icon = toolIcons[effectiveName] || toolIcons[toolCall.name] || '🔧';
    const verb =
        applyPatchDisplay?.verb ||
        TOOL_VERBS[effectiveName] ||
        TOOL_VERBS[toolCall.name] ||
        toolCall.name.split('.').pop() ||
        '';
    const category = getToolCategory(effectiveName);
    const categoryColor = CATEGORY_COLORS[category];
    const built = buildToolMeta(effectiveName, rawArgs);
    const description = applyPatchDisplay?.description || built.description;
    const detail = applyPatchDisplay?.detail ?? built.detail;
    const fullPath = built.fullPath;

    // Build diff lines for write tools (color-coded preview)
    const isWriteTool = WRITE_TOOLS.has(effectiveName);
    const diffLines = isWriteTool ? buildDiffLines(effectiveName, rawArgs) : [];
    const hasDiffPreview = diffLines.length > 0;

    // Content preview for read results
    const isReadTool = READ_TOOLS.has(effectiveName);
    const readSnippet = isReadTool ? readResultSnippet(toolCall.result) : null;

    const hasContentPreview = hasDiffPreview || !!readSnippet;

    // Build per-patch info for expanded view (multi-patch applyPatch)
    const patchItems = patches.map((p, idx) => {
        const patchOp = p.op || '';
        const patchPath = p.path || '';
        const patchLines = lineCount(p.newContent);
        const effName = patchOp === 'create' ? 'fs.create' : patchOp === 'delete' ? 'fs.delete' : patchOp === 'replace' ? 'fs.replace' : 'fs.applyPatch';
        const pIcon = toolIcons[effName] || '🩹';
        const pVerb = TOOL_VERBS[effName] || patchOp || '补丁';
        // Build diff lines for each individual patch
        const pDiffLines = buildDiffLines(effName, {
            path: patchPath,
            search: p.search,
            replace: p.replace,
            newContent: p.newContent,
        });
        return { idx, path: shortPath(patchPath), fullPath: patchPath, verb: pVerb, icon: pIcon, lines: patchLines, op: patchOp, diffLines: pDiffLines };
    });

    const isShell = toolCall.name === 'shell.exec' || toolCall.name === 'shell.session';
    const shellCmd = isShell
        ? String(rawArgs.command ?? toolCall.result?.command ?? description ?? '').trim()
        : '';
    const shellCwd = isShell ? resolveShellCwd(rawArgs, toolCall.result) : '';
    const executionState: ToolExecutionState | undefined =
        toolCall.executionState
        ?? (isShell && toolCall.result
            ? deriveShellExecutionState(status, toolCall.result)
            : status);
    const terminal = executionState && executionState !== 'running';

    const statusLabel =
        executionState === 'denied' ? '已拒绝'
        : executionState === 'skipped' ? '已跳过'
        : executionState === 'success' ? '✓'
        : executionState === 'error' ? '✗'
        : null;

    return (
        <div className={'tool-call-card tool-call-' + (executionState ?? status)}>
            {isShell && shellCmd ? (
                <div className="tool-call-shell-primary">
                    <span className="tool-call-icon">{icon}</span>
                    <ShellCommandHeader command={shellCmd} cwd={shellCwd} />
                    <span className={'tool-call-status tool-call-status-' + (executionState ?? status)}>
                        {status === 'running' && !shellAsk && <span className="tool-call-spinner" />}
                        {statusLabel}
                    </span>
                </div>
            ) : !isGatherExecute ? (
                <>
                    <span className="tool-call-icon">{icon}</span>
                    <span className="tool-call-verb" style={{ color: categoryColor }}>{verb}</span>
                    <span className="tool-call-desc" title={fullPath || description}>{description}</span>
                    {detail && <span className="tool-call-detail muted">{detail}</span>}
                </>
            ) : null}
            {isGatherExecute && (
                <>
                    <span className="tool-call-icon">📥</span>
                    <span className="tool-call-verb" style={{ color: '#4ec9b0' }}>收集</span>
                    <span className="tool-call-detail">{gatherRequests.length} 个文件</span>
                </>
            )}
            {/* Expand/collapse toggle for tools with content previews */}
            {hasContentPreview && !hasMultiplePatches && (
                <button
                    type="button"
                    className="agent-file-expand-btn tool-call-expand-btn"
                    onClick={() => setExpanded(!expanded)}
                >
                    {expanded ? '▾ 收起' : '▸ 展开详情'}
                </button>
            )}
            {hasMultiplePatches && (
                <button
                    type="button"
                    className="agent-file-expand-btn tool-call-expand-btn"
                    onClick={() => setExpanded(!expanded)}
                >
                    {expanded ? '▾ 收起' : '▸ 展开详情'}
                </button>
            )}
            {!isShell && (
            <span className={'tool-call-status tool-call-status-' + status}>
                {status === 'running' && !shellAsk && <span className="tool-call-spinner" />}
                {status === 'success' && '✓'}
                {status === 'error' && '✗'}
            </span>
            )}
            {status === 'error' && typeof toolCall.result?.errorMessage === 'string' && (
                <span className="tool-call-detail muted" title={toolCall.result.errorMessage}>
                    {toolCall.result.errorMessage}
                </span>
            )}
            {toolCall.name === 'shell.exec' && shellAsk && (
                <ShellAskBar ask={shellAsk} />
            )}
            {/* Write tool diff preview (green for additions, red for deletions) */}
            {expanded && hasDiffPreview && !hasMultiplePatches && (
                <div className="tool-call-content-preview">
                    {effectiveName === 'fs.create' && (
                        <div className="tool-call-preview-label muted">新建文件内容：</div>
                    )}
                    {effectiveName === 'fs.write' && (
                        <div className="tool-call-preview-label muted">写入内容：</div>
                    )}
                    {effectiveName === 'fs.replace' && (
                        <div className="tool-call-preview-label muted">替换内容：</div>
                    )}
                    {effectiveName === 'fs.delete' && (
                        <div className="tool-call-preview-label muted">删除文件：</div>
                    )}
                    <DiffPreview diffLines={diffLines} />
                </div>
            )}
            {/* Read tool result content preview */}
            {expanded && readSnippet && !hasMultiplePatches && (
                <div className="tool-call-content-preview">
                    <div className="tool-call-preview-label muted">文件内容：</div>
                    <pre className="tool-call-preview-code">{readSnippet}</pre>
                </div>
            )}
            {/* Full path display for file tools when expanded */}
            {expanded && fullPath && fullPath !== description && (
                <div className="tool-call-full-path muted">完整路径：{fullPath}</div>
            )}
            {/* Multi-patch applyPatch: show each patch with its own diff */}
            {expanded && hasMultiplePatches && (
                <div className="tool-call-patches">
                    {patchItems.map((p) => (
                        <div key={p.idx} className="tool-call-patch-item tool-call-patch-item-expandable">
                            <div className="tool-call-patch-header">
                                <span className="tool-call-patch-icon">{p.icon}</span>
                                <span className="tool-call-patch-verb">{p.verb}</span>
                                <span className="tool-call-patch-path" title={p.fullPath}>{p.path}</span>
                                {p.lines > 0 && <span className="tool-call-patch-lines">{p.lines} 行</span>}
                            </div>
                            {p.diffLines.length > 0 && (
                                <DiffPreview diffLines={p.diffLines} />
                            )}
                        </div>
                    ))}
                </div>
            )}
            {(toolCall.name === 'shell.exec' || toolCall.name === 'shell.session') && toolCall.result && (
                <ShellOutputPreview result={toolCall.result} />
            )}
            {(toolCall.name === 'shell.exec' || toolCall.name === 'shell.session') && terminal && executionState === 'denied' && (
                <div className="tool-call-shell-state muted">命令未执行（用户拒绝）</div>
            )}
            {(toolCall.name === 'shell.exec' || toolCall.name === 'shell.session') && terminal && executionState === 'skipped' && (
                <div className="tool-call-shell-state muted">命令未执行（用户跳过）</div>
            )}
            {isGatherExecute && gatherRequests.length > 0 && (
                <div className="tool-call-patches">
                    {gatherRequests.map((req, reqIdx) => {
                        const kind = req.kind || '';
                        const reqArgs = req.args || {};
                        const reqPath = shortPath((reqArgs.path as string) || '');
                        const rIcon = toolIcons[kind] || '🔧';
                        const rVerb = TOOL_VERBS[kind] || kind.split('.').pop() || kind;
                        const reqStartLine = reqArgs.startLine as number | undefined;
                        const reqEndLine = reqArgs.endLine as number | undefined;
                        const range = reqStartLine && reqEndLine ? ':' + reqStartLine + '-' + reqEndLine : '';
                        return (
                            <div key={req.id || reqIdx} className="tool-call-patch-item">
                                <span className="tool-call-patch-icon">{rIcon}</span>
                                <span className="tool-call-patch-verb">{rVerb}</span>
                                <span className="tool-call-patch-path">{reqPath}{range}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
