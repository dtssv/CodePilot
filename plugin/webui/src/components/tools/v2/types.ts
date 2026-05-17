/**
 * v2 tool result payload kinds — produced by Kotlin
 * `io.codepilot.plugin.protocol.ToolResultClassifier` and consumed by the
 * components in this directory.
 *
 * If you add a new `kind` server-side, also add a matching renderer here and
 * extend the `dispatch` table in ToolResultView.tsx.
 */

export type ToolResultPayload =
    | { kind: 'fs.read'; path: string; lang?: string; totalLines?: number; bytes?: number;
        truncated?: boolean; content: string; range?: { startLine?: number; endLine?: number } | null }
    | { kind: 'fs.list'; path: string; entries: Array<{ name: string; type: 'file' | 'dir'; size?: number }> }
    | { kind: 'fs.write'; op: string; path: string; appliedVia?: string; routedAs?: string }
    | { kind: 'grep'; pattern: string; matches: Array<{ path: string; line: number; preview: string; context?: string }>;
        total: number; truncated: boolean }
    | { kind: 'shell'; command: string; cwd: string; exitCode: number;
        stdout: string; stderr: string; durationMs: number; timedOut?: boolean; os?: string }
    | { kind: 'ide.openFile'; path: string; line?: number }
    | { kind: 'ide.diagnostics'; path: string;
        diagnostics: Array<{ line: number; severity: string; message: string }> }
    | { kind: 'ide.shadowValidate'; passed: boolean;
        errors: Array<{ file: string; line: number; message: string; severity: string }>;
        durationMs: number }
    | { kind: 'code.outline'; path: string; outline: unknown }
    | { kind: 'mcp'; server: string; tool: string; content: unknown }
    | { kind: 'notepad'; op: string; content: unknown }
    | { kind: 'error'; tool?: string; errorCode?: string | null; errorMessage: string; raw?: unknown }
    | { kind: 'unknown'; tool?: string; raw: unknown };
