/** Format and preview shell tool stdout/stderr for tool cards. */

export const SHELL_PREVIEW_LINES = 4;

export function formatShellOutput(result: Record<string, unknown>): string {
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

export function shellOutputLines(text: string): string[] {
    if (!text) return [];
    return text.split('\n');
}

export function previewShellOutput(text: string, maxLines = SHELL_PREVIEW_LINES): {
    preview: string;
    rest: string;
    truncated: boolean;
} {
    const lines = shellOutputLines(text);
    if (lines.length <= maxLines) {
        return { preview: text, rest: '', truncated: false };
    }
    const preview = lines.slice(0, maxLines).join('\n');
    const rest = lines.slice(maxLines).join('\n');
    return { preview, rest, truncated: true };
}

export function deriveShellExecutionState(
    status: 'running' | 'success' | 'error' | undefined,
    result?: Record<string, unknown>,
): 'running' | 'success' | 'error' | 'denied' | 'skipped' {
    if (status === 'running') return 'running';
    const stderr = String(result?.stderr ?? '');
    const exitCode = result?.exitCode;
    if (stderr.includes('用户已跳过') || stderr.includes('Skipped by user')) {
        return 'skipped';
    }
    if (
        stderr.includes('用户已拒绝') ||
        stderr.includes('Denied:') ||
        (exitCode === -1 && stderr.toLowerCase().includes('denied'))
    ) {
        return 'denied';
    }
    if (status === 'error') return 'error';
    return 'success';
}
