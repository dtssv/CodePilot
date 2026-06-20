/** SSE done.reason values that end the active conversation turn. */
export const TERMINAL_DONE_REASONS = new Set([
    'final',
    'failed',
    'stopped',
    'max_steps',
    'partial',
    'deploy_draining',
    'task_complete',
    'goal_not_met',
    'context_overflow',
    'user_stopped',
    'error',
]);

export function isTerminalDoneReason(reason: string | undefined): boolean {
    return TERMINAL_DONE_REASONS.has(reason ?? '');
}
