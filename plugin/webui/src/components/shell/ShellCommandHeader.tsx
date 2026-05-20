/** Shell tool card header: working directory first, then $ command. */

export function resolveShellCwd(args: Record<string, unknown>, result?: Record<string, unknown>): string {
    const fromArgs = String(args.cwd ?? '').trim();
    if (fromArgs && fromArgs !== 'default' && fromArgs !== '.') return fromArgs;
    const fromResult = String(result?.cwd ?? '').trim();
    if (fromResult) return fromResult;
    return '';
}

export function ShellCommandHeader({
    command,
    cwd,
}: {
    command: string;
    cwd?: string;
}) {
    const cmd = command.trim() || 'shell';
    return (
        <div className="shell-command-header">
            {cwd ? (
                <span className="shell-command-cwd muted" title={cwd}>
                    {cwd}
                </span>
            ) : null}
            <code className="shell-command-line" title={cmd}>
                $ {cmd}
            </code>
        </div>
    );
}
