import type { StepNode } from '../../../state/events';
import type { ToolCallInfo } from '../../ToolCallCard';
import type { ToolExecutionState } from '../../../state/chatTypes';
import { classifyToolResult } from '../../../utils/toolResultClassify';
import { deriveShellExecutionState } from '../../../utils/shellOutput';
import { normalizeToolArgs } from '../../../utils/toolArgs';

function shellResultRecord(step: StepNode): Record<string, unknown> | undefined {
    const raw = step.toolResult?.result;
    if (!raw || typeof raw !== 'object') return undefined;
    const p = raw as Record<string, unknown>;
    if (p.kind === 'shell') {
        return {
            command: p.command,
            cwd: p.cwd,
            stdout: p.stdout,
            stderr: p.stderr,
            exitCode: p.exitCode,
            durationMs: p.durationMs,
            timedOut: p.timedOut,
        };
    }
    return p;
}

export function stepToToolCall(step: StepNode): ToolCallInfo | null {
    if (!step.toolCall) return null;
    const args = normalizeToolArgs(step.toolCall.args);
    const status = step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'success';
    const toolName = step.toolCall.tool;
    const isShell = toolName.startsWith('shell.');
    const classified = step.toolResult
        ? classifyToolResult(
              toolName,
              args,
              step.toolResult.ok,
              step.toolResult.result,
              null,
              step.toolResult.error,
          )
        : null;
    const result =
        isShell
            ? shellResultRecord(step)
            : classified && typeof classified === 'object' && !Array.isArray(classified)
              ? (classified as Record<string, unknown>)
              : undefined;
    const executionState: ToolExecutionState | undefined =
        step.executionState
        ?? (isShell ? deriveShellExecutionState(status, result) : status);
    return {
        id: step.stepId,
        name: toolName,
        args,
        status,
        result,
        executionState,
    };
}

export function shouldHideToolStep(_step: StepNode, _allSteps: StepNode[]): boolean {
    return false;
}
