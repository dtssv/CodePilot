import type { StepNode } from '../../../state/events';
import type { ToolCallInfo } from '../../ToolCallCard';

const WRITE_TOOLS = ['fs.write', 'fs.create', 'fs.replace', 'fs.applyPatch', 'fs.delete', 'fs.move'];

export function stepToToolCall(step: StepNode): ToolCallInfo | null {
    if (!step.toolCall) return null;
    const args =
        step.toolCall.args && typeof step.toolCall.args === 'object'
            ? (step.toolCall.args as Record<string, unknown>)
            : {};
    return {
        id: step.stepId,
        name: step.toolCall.tool,
        args,
        status: step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'success',
    };
}

export function shouldHideToolStep(step: StepNode, allSteps: StepNode[]): boolean {
    const tool = step.toolCall?.tool ?? '';
    if (!WRITE_TOOLS.some((p) => tool.startsWith(p))) return false;
    return allSteps.some((s) => s.kind === 'writing' || s.kind === 'running');
}
