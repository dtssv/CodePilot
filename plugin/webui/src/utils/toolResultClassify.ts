/**
 * Mirror of Kotlin `ToolResultClassifier` for session replay / hydrate.
 * Produces the same `kind`-discriminated payloads the live envelope path uses.
 */

import type { ToolResultPayload } from '../components/tools/v2/types';

function asRecord(v: unknown): Record<string, unknown> | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
}

function str(v: unknown, fallback = ''): string {
    return v == null ? fallback : String(v);
}

function extractReadRange(args?: Record<string, unknown>): { startLine?: number; endLine?: number } | null {
    const rng = args?.range;
    if (!rng || typeof rng !== 'object') return null;
    const r = rng as Record<string, unknown>;
    const s = typeof r.startLine === 'number' && r.startLine > 0 ? r.startLine : undefined;
    const e = typeof r.endLine === 'number' && r.endLine > 0 ? r.endLine : undefined;
    if (s == null && e == null) return null;
    return { startLine: s, endLine: e };
}

const WRITE_TOOLS = new Set([
    'fs.write', 'fs.create', 'fs.replace', 'fs.delete', 'fs.move', 'fs.applyPatch',
]);

/** Classify a raw dispatcher result into a v2 ToolResultPayload-shaped object. */
export function classifyToolResult(
    toolName: string,
    args: Record<string, unknown> | undefined,
    ok: boolean,
    result: unknown,
    errorCode?: string | null,
    errorMessage?: string | null,
): ToolResultPayload | Record<string, unknown> {
    if (!ok) {
        return {
            kind: 'error',
            tool: toolName,
            errorCode: errorCode ?? null,
            errorMessage: errorMessage ?? 'Tool failed',
            raw: result,
        };
    }

    const m = asRecord(result);
    if (!m) {
        return { kind: 'unknown', tool: toolName, raw: result };
    }

    if (toolName === 'fs.read' && m.isDirectory === true) {
        return {
            kind: 'fs.list',
            path: str(m.path),
            entries: (m.entries as Array<{ name: string; type: 'file' | 'dir'; size?: number }>) ?? [],
        };
    }

    if (toolName === 'fs.read' || toolName === 'fs.outline') {
        return {
            kind: 'fs.read',
            path: str(m.path ?? args?.path),
            lang: m.lang as string | undefined,
            totalLines: m.totalLines as number | undefined,
            bytes: m.bytes as number | undefined,
            truncated: m.truncated === true,
            content: str(m.content),
            range: extractReadRange(args),
        };
    }

    if (toolName === 'fs.list') {
        return {
            kind: 'fs.list',
            path: str(m.path ?? args?.path),
            entries: (m.entries as Array<{ name: string; type: 'file' | 'dir'; size?: number }>) ?? [],
        };
    }

    if (toolName === 'fs.grep' || toolName === 'fs.search') {
        const rawHits = Array.isArray(m.hits) ? m.hits : [];
        const matches = rawHits.map((hit) => {
            const h = asRecord(hit);
            if (!h) return null;
            return {
                path: str(h.path),
                line: typeof h.line === 'number' ? h.line : 0,
                preview: str(h.matchLine ?? h.preview),
                context: h.context as string | undefined,
            };
        }).filter((x): x is NonNullable<typeof x> => x != null);
        const total = typeof m.totalHits === 'number' ? m.totalHits : matches.length;
        return {
            kind: 'grep',
            pattern: str(m.pattern ?? args?.pattern),
            matches,
            total,
            truncated: total > matches.length,
        };
    }

    if (toolName === 'shell.exec' || toolName === 'shell.session') {
        return {
            kind: 'shell',
            command: str(args?.command ?? m.command),
            cwd: str(m.cwd ?? args?.cwd),
            exitCode: typeof m.exitCode === 'number' ? m.exitCode : -1,
            stdout: str(m.stdout),
            stderr: str(m.stderr),
            durationMs: typeof m.durationMs === 'number' ? m.durationMs : 0,
            timedOut: m.timedOut === true,
            os: m.os as string | undefined,
        };
    }

    if (WRITE_TOOLS.has(toolName)) {
        const op = str(m.originalOp ?? toolName.replace(/^fs\./, ''));
        return {
            kind: 'fs.write',
            op,
            path: str(m.path ?? args?.path),
            appliedVia: m.appliedVia as string | undefined,
            routedAs: m.routedAs as string | undefined,
        };
    }

    if (toolName === 'ide.openFile') {
        return { kind: 'ide.openFile', path: str(m.opened), line: m.line as number | undefined };
    }

    if (toolName === 'ide.diagnostics') {
        return {
            kind: 'ide.diagnostics',
            path: str(m.path ?? args?.path),
            diagnostics: (m.diagnostics as Array<{ line: number; severity: string; message: string }>) ?? [],
        };
    }

    if (toolName === 'ide.shadowValidate') {
        return {
            kind: 'ide.shadowValidate',
            passed: m.passed === true,
            errors: (m.errors as Array<{ file: string; line: number; message: string; severity: string }>) ?? [],
            durationMs: typeof m.durationMs === 'number' ? m.durationMs : 0,
        };
    }

    if (toolName === 'code.outline') {
        return {
            kind: 'code.outline',
            path: str(m.path ?? args?.path),
            outline: m.outline ?? [],
        };
    }

    if (toolName.startsWith('mcp.')) {
        const parts = toolName.slice(4).split('.', 2);
        return {
            kind: 'mcp',
            server: parts[0] ?? '',
            tool: parts[1] ?? '',
            content: m,
        };
    }

    if (toolName.startsWith('notepad.')) {
        return { kind: 'notepad', op: toolName.slice('notepad.'.length), content: m };
    }

    // Already classified (e.g. replayed from a prior v2 envelope)
    if (typeof m.kind === 'string' && m.kind !== 'unknown') {
        return m as ToolResultPayload;
    }

    return { kind: 'unknown', tool: toolName, raw: m };
}

export function isReadLikeTool(toolName: string): boolean {
    return toolName === 'fs.read' || toolName === 'fs.list' || toolName === 'fs.grep'
        || toolName === 'fs.search' || toolName === 'fs.outline' || toolName === 'code.outline';
}

export function isWriteLikeTool(toolName: string): boolean {
    return WRITE_TOOLS.has(toolName) || toolName.startsWith('fs.applyPatch');
}
