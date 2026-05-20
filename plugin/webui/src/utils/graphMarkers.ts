import { normalizeMarkdownForDisplay } from './markdownNormalize';

/** Complete graph stream markers. */
const MARKER_TOKEN =
    /(?:<<<)?\s*(?:GRAPH_JSON|AGENT_CONTENT|AGENT_THINKING|AGENT_W(?:RITING|ITING)|AGENT_READING|END)\s*>>>?/gi;
/** Bare/truncated: AGENT_CONTENT>, END>, GRAPH_JSON without <<< */
const LOOSE_MARKER =
    /(?:<<<)?\s*(?:GRAPH_JSON|AGENT_CONTENT|AGENT_THINKING|AGENT_W(?:RITING|ITING)|AGENT_READING|END)(?:\s*>>>+)?>?/gi;
const GLUED_MARKER_NAMES =
    /(?:GRAPH_JSON|AGENT_CONTENT|AGENT_THINKING|AGENT_W(?:RITING|ITING)|AGENT_READING|END)/gi;

const PARTIAL_MARKER = /<<<(?:GRAPH_JSON|AGENT_CONTENT|AGENT_THINKING|AGENT_W(?:RITING|ITING)|AGENT_READING|END)?>?$/i;

const ORPHAN_BRACKETS = /<<<+>?|<<>+/g;

const LONE_ANGLE = /(?<=[\p{L}\p{N}。！？.!?])\s*>\s*(?=[\p{L}\p{N}#])/gu;

/** Graph generate JSON leaked without markers — hide from chat. */
export function stripLeakedGraphJson(text: string): string {
    const t = text.trim();
    if (!t.startsWith('{') || t.length < 24) return text;
    if (
        t.includes('"toolCalls"') ||
        t.includes('"thought"') ||
        t.includes('"infoRequests"') ||
        t.includes('"agentThinking"') ||
        t.includes('"patches"')
    ) {
        return '';
    }
    return text;
}

/** Remove graph streaming markers from user-visible text. */
export function stripGraphMarkers(text: string): string {
    if (!text) return '';
    let s = text.replace(MARKER_TOKEN, '').replace(LOOSE_MARKER, '');
    let prev: string;
    do {
        prev = s;
        s = s.replace(GLUED_MARKER_NAMES, '');
    } while (s !== prev);
    return s
        .replace(ORPHAN_BRACKETS, '')
        .replace(PARTIAL_MARKER, '')
        .replace(LONE_ANGLE, '')
        .trim();
}

const FILE_TOOL_PREVIEW =
    /(?:^|\s|>)\s*(?:想要)?(?:新建|创建|修改|删除|写入)(?:文件)?[:：]\s*\S+(?:\s*\+\d+\s*行)?/gim;

const REPETITIVE_USER_GOAL =
    /(?:用户要求|根据项目上下文|根据GATHERED CONTEXT|我的方法是先|行动计划|开始制定.*计划|我将检查.*CMake|根目录下已存在)/i;

/** Normalize LLM output before rendering in chat. */
export function normalizeAgentContentText(text: string): string {
    let s = stripLeakedGraphJson(stripGraphMarkers(text));
    s = s.replace(/<filepath\s*=/gi, '<file path=');
    s = s.replace(/<filepath\s+path\s*=/gi, '<file path=');
    s = s.replace(/<file(?:path)?\s[^>]*>[\s\S]*?<\/file(?:path)?>/gi, '');
    s = s.replace(/<plan>([\s\S]*?)<\/plan>/gi, '$1');
    s = s.replace(/<\/?plan>/gi, '');
    s = s.replace(/<\/plan[^\n>]*/gi, '');
    s = s.replace(/<\/plan\s*$/gi, '');
    s = s.replace(/<\/plan(?!>)/gi, '');
    s = s.replace(/<plan-[^\n>]*/gi, '');
    s = s.replace(/<plan\s+[^\n>]*/gi, '');
    s = s.replace(/<plan[^>\n]*/gi, '');
    s = s.replace(/^(正在|配置|编译|查找|运行).*(…|\.\.\.)?\s*success\s*$/gim, '');
    s = s.replace(FILE_TOOL_PREVIEW, '');
    s = s
        .split(/(?<=[。！？.!?])\s*/)
        .filter((part) => part.trim() && !REPETITIVE_USER_GOAL.test(part.trim()))
        .join('\n');
    s = s.replace(/(?<=。)\s*>\s*(?=[\u4e00-\u9fffA-Za-z])/g, '');
    s = s.replace(/\s*>\s*$/gm, '');
    s = normalizeMarkdownForDisplay(s);
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

export { normalizeMarkdownForDisplay } from './markdownNormalize';

export interface PatchItem {
    path?: string;
    op?: string;
    newContent?: string;
    search?: string;
    replace?: string;
}

/** Count leaf file edits (Patch envelope vs flat edit). */
export function extractPatchItems(args: Record<string, unknown>): PatchItem[] {
    const patches = args.patches as unknown[];
    if (patches && Array.isArray(patches) && patches.length > 0) {
        const result: PatchItem[] = [];
        for (const p of patches) {
            if (!p || typeof p !== 'object') continue;
            const po = p as Record<string, unknown>;
            const innerPatches = po.patches as unknown[] | undefined;
            if (innerPatches && Array.isArray(innerPatches) && innerPatches.length > 0) {
                for (const ip of innerPatches) {
                    if (!ip || typeof ip !== 'object') continue;
                    const leaf = ip as PatchItem;
                    if (leaf.path) result.push(leaf);
                }
            } else if (typeof po.path === 'string' && po.path) {
                result.push({
                    path: po.path,
                    op: po.op as string | undefined,
                    newContent: po.newContent as string | undefined,
                    search: po.search as string | undefined,
                    replace: po.replace as string | undefined,
                });
            }
        }
        const seen = new Set<string>();
        return result.filter((p) => {
            const key = (p.path || '').trim();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    const op = (args.op as string) || '';
    const path = (args.path as string) || '';
    if (op || path) {
        return [{
            path,
            op,
            newContent: args.newContent as string | undefined,
            search: args.search as string | undefined,
            replace: args.replace as string | undefined,
        }];
    }
    return [];
}

function shortPath(p: string): string {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
}

function dominantVerb(patches: PatchItem[]): string {
    if (patches.length === 0) return '写入';
    const ops = patches.map((p) => (p.op || 'write').toLowerCase());
    if (ops.every((o) => o === 'create')) return '创建';
    if (ops.every((o) => o === 'delete')) return '删除';
    if (ops.every((o) => o === 'replace')) return '替换';
    return '修改';
}

export interface ApplyPatchDisplay {
    verb: string;
    description: string;
    detail: string;
}

/** User-facing fs.applyPatch summary (by op, not generic "patch"). */
export function summarizeApplyPatch(args: Record<string, unknown>): ApplyPatchDisplay {
    const patches = extractPatchItems(args);
    if (patches.length === 0) {
        return { verb: '写入', description: '', detail: '' };
    }
    const verb = dominantVerb(patches);
    if (patches.length === 1) {
        const p = patches[0];
        const lines = p.newContent ? p.newContent.split('\n').length : 0;
        return {
            verb,
            description: shortPath(p.path || ''),
            detail: lines > 0 ? `${lines} 行` : '',
        };
    }
    const names = patches.slice(0, 3).map((p) => shortPath(p.path || '')).filter(Boolean);
    return {
        verb,
        description: `${patches.length} 个文件`,
        detail: names.join(', '),
    };
}
