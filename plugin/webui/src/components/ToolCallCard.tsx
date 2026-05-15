import { useEffect, useState } from 'react';

export interface ToolCallInfo {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status?: 'running' | 'success' | 'error';
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

function shortPath(p: string): string {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
}

function lineCount(s: string | undefined): number {
    if (!s) return 0;
    return s.split('\n').length;
}

interface PatchItem {
    path?: string;
    op?: string;
    newContent?: string;
    search?: string;
    replace?: string;
}

function extractPatches(args: Record<string, unknown>): PatchItem[] {
    // If patches array exists (fs.applyPatch multi-patch format)
    const patches = args.patches as PatchItem[] | undefined;
    if (patches && Array.isArray(patches) && patches.length > 0) {
        return patches;
    }
    // Single patch format (top-level op/path/newContent)
    const op = (args.op as string) || '';
    const path = (args.path as string) || '';
    if (op || path) {
        return [{ path, op, newContent: args.newContent as string | undefined, search: args.search as string | undefined, replace: args.replace as string | undefined }];
    }
    return [];
}

function buildToolMeta(name: string, args: Record<string, unknown>): { description: string; detail: string } {
    const path = (args.path as string) || '';
    const op = (args.op as string) || '';
    const content = (args.newContent as string) || (args.content as string) || (args.replace as string) || '';
    const search = (args.search as string) || '';
    const lines = lineCount(content);
    const sp = shortPath(path);
    const startLine = args.startLine as number | undefined;
    const endLine = args.endLine as number | undefined;

    switch (name) {
        case 'fs.read': {
            const range = startLine && endLine ? ':' + startLine + '-' + endLine : '';
            return { description: sp + range, detail: startLine && endLine ? (endLine - startLine + 1) + ' 行' : '' };
        }
        case 'fs.list':
            return { description: sp || '.', detail: '' };
        case 'fs.search':
        case 'fs.grep': {
            const q = (args.query as string) || '';
            return { description: q.length > 40 ? q.substring(0, 40) + '...' : q, detail: sp ? sp : '' };
        }
        case 'fs.outline':
            return { description: sp, detail: '' };
        case 'fs.create':
            return { description: sp, detail: lines > 0 ? lines + ' 行' : '' };
        case 'fs.write':
            return { description: sp, detail: lines > 0 ? lines + ' 行' : '' };
        case 'fs.replace':
            return { description: sp, detail: lines > 0 ? lines + ' 行' : search ? '文本替换' : '' };
        case 'fs.delete':
            return { description: sp, detail: '' };
        case 'fs.move':
            return { description: sp + ' → ' + shortPath((args.destination as string) || (args.to as string) || ''), detail: '' };
        case 'fs.applyPatch': {
            const patches = extractPatches(args);
            if (patches.length > 0) {
                // Multi-patch: summarize file count
                const fileCount = patches.length;
                const firstPath = shortPath(patches[0]?.path || '');
                if (fileCount === 1) {
                    const p = patches[0];
                    const patchOp = p.op || '';
                    const patchLines = lineCount(p.newContent);
                    if (patchOp === 'create') return { description: firstPath, detail: patchLines > 0 ? patchLines + ' 行' : '' };
                    if (patchOp === 'delete') return { description: firstPath, detail: '' };
                    return { description: firstPath, detail: patchLines > 0 ? patchLines + ' 行' : '' };
                }
                return { description: firstPath + (fileCount > 1 ? ` +${fileCount - 1}` : ''), detail: fileCount + ' 个文件' };
            }
            // Fallback: single top-level op
            const patchLines = lineCount(args.newContent as string | undefined);
            if (op === 'create') return { description: sp, detail: patchLines > 0 ? patchLines + ' 行' : '' };
            if (op === 'delete') return { description: sp, detail: '' };
            return { description: sp, detail: patchLines > 0 ? patchLines + ' 行' : '' };
        }
        case 'ide.openFile': {
            const line = args.line as number | undefined;
            return { description: sp, detail: line ? ':' + line : '' };
        }
        case 'ide.diagnostics':
            return { description: sp || '项目', detail: '' };
        case 'ide.applyPatch':
            return { description: '应用补丁', detail: '' };
        case 'ide.shadowValidate': {
            const vType = (args.validateType as string) || '';
            return { description: vType === 'compile' ? '编译检查' : vType || '验证', detail: '' };
        }
        case 'shell.exec': {
            const cmd = (args.command as string) || '';
            return { description: cmd.length > 50 ? cmd.substring(0, 50) + '...' : cmd, detail: sp ? sp : '' };
        }
        case 'shell.session':
            return { description: (args.action as string) || 'exec', detail: '' };
        case 'code.outline':
            return { description: sp, detail: '' };
        case 'code.symbol':
            return { description: (args.query as string) || '', detail: sp ? sp : '' };
        case 'code.usages':
            return { description: (args.symbol as string) || '', detail: sp ? sp : '' };
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
            // First file path as main description, file count as detail
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

export function ToolCallCard({ toolCall }: { toolCall: ToolCallInfo }) {
    const [status, setStatus] = useState<'running' | 'success' | 'error'>(toolCall.status || 'running');
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (toolCall.status && toolCall.status !== status) {
            setStatus(toolCall.status);
        }
    }, [toolCall.status]);

    // Resolve effective tool name for fs.applyPatch based on op field
    // The args may come as a nested object from the backend SSE stream
    const rawArgs = toolCall.args || {};
    const op = (rawArgs.op as string) || '';
    const patches = toolCall.name === 'fs.applyPatch' ? extractPatches(rawArgs) : [];
    const hasMultiplePatches = patches.length > 1;

    // ★ gather.execute: extract sub-requests for inline display
    const isGatherExecute = toolCall.name === 'gather.execute';
    const gatherRequests = isGatherExecute
        ? (rawArgs.requests as { id?: string; kind?: string; args?: Record<string, unknown> }[] | undefined) || []
        : [];

    // For single patch, resolve effective name based on op
    const effectiveName = toolCall.name === 'fs.applyPatch' && !hasMultiplePatches && op
        ? (op === 'create' ? 'fs.create' : op === 'delete' ? 'fs.delete' : op === 'replace' ? 'fs.replace' : toolCall.name)
        : toolCall.name;

    const icon = toolIcons[effectiveName] || toolIcons[toolCall.name] || '🔧';
    const verb = TOOL_VERBS[effectiveName] || TOOL_VERBS[toolCall.name] || toolCall.name.split('.').pop() || '';
    const category = getToolCategory(effectiveName);
    const categoryColor = CATEGORY_COLORS[category];
    const { description, detail } = buildToolMeta(effectiveName, rawArgs);

    // Build per-patch info for expanded view
    const patchItems = patches.map((p, idx) => {
        const patchOp = p.op || '';
        const patchPath = p.path || '';
        const patchLines = lineCount(p.newContent);
        const effName = patchOp === 'create' ? 'fs.create' : patchOp === 'delete' ? 'fs.delete' : patchOp === 'replace' ? 'fs.replace' : 'fs.applyPatch';
        const pIcon = toolIcons[effName] || '🩹';
        const pVerb = TOOL_VERBS[effName] || patchOp || '补丁';
        return { idx, path: shortPath(patchPath), verb: pVerb, icon: pIcon, lines: patchLines, op: patchOp };
    });

    return (
        <div className={'tool-call-card tool-call-' + status}>
            {!isGatherExecute && (
                <>
                    <span className="tool-call-icon">{icon}</span>
                    <span className="tool-call-verb" style={{ color: categoryColor }}>{verb}</span>
                    <span className="tool-call-desc" title={description}>{description}</span>
                    {detail && <span className="tool-call-detail">{detail}</span>}
                </>
            )}
            {isGatherExecute && (
                <>
                    <span className="tool-call-icon">📥</span>
                    <span className="tool-call-verb" style={{ color: '#4ec9b0' }}>收集</span>
                    <span className="tool-call-detail">{gatherRequests.length} 个文件</span>
                </>
            )}
            {hasMultiplePatches && (
                <button className="tool-call-expand-btn" onClick={() => setExpanded(!expanded)} title={expanded ? '收起' : '展开'}>
                    {expanded ? '▾' : '▸'}
                </button>
            )}
            <span className={'tool-call-status tool-call-status-' + status}>
                {status === 'running' && <span className="tool-call-spinner" />}
                {status === 'success' && '✓'}
                {status === 'error' && '✗'}
            </span>
            {expanded && hasMultiplePatches && (
                <div className="tool-call-patches">
                    {patchItems.map((p) => (
                        <div key={p.idx} className="tool-call-patch-item">
                            <span className="tool-call-patch-icon">{p.icon}</span>
                            <span className="tool-call-patch-verb">{p.verb}</span>
                            <span className="tool-call-patch-path">{p.path}</span>
                            {p.lines > 0 && <span className="tool-call-patch-lines">{p.lines} 行</span>}
                        </div>
                    ))}
                </div>
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