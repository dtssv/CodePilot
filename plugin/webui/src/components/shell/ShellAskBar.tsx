import type { ShellAskRequest } from '../../state/shellAskStore';
import { respondShellGrant } from '../../state/shellAskStore';

export interface ShellAskBarProps {
    ask: ShellAskRequest;
}

/** Inline run / deny / skip actions shown on a shell tool row (replaces IDE modal). */
export function ShellAskBar({ ask }: ShellAskBarProps) {
    const showReason = ask.reason && ask.reason !== 'default';
    return (
        <div className="shell-ask-bar" role="group" aria-label="Shell command approval">
            {ask.cwd ? <span className="shell-ask-cwd muted" title={ask.cwd}>{ask.cwd}</span> : null}
            <code className="shell-ask-command" title={ask.command}>
                $ {ask.command}
            </code>
            {showReason ? <span className="shell-ask-reason muted">{ask.reason}</span> : null}
            <div className="shell-ask-actions">
                <button
                    type="button"
                    className="shell-ask-btn shell-ask-btn-run"
                    onClick={() => respondShellGrant(ask, 'allow')}
                >
                    运行
                </button>
                <button
                    type="button"
                    className="shell-ask-btn shell-ask-btn-deny"
                    onClick={() => respondShellGrant(ask, 'deny')}
                >
                    拒绝
                </button>
                <button
                    type="button"
                    className="shell-ask-btn shell-ask-btn-skip"
                    onClick={() => respondShellGrant(ask, 'skip')}
                >
                    跳过
                </button>
            </div>
        </div>
    );
}
