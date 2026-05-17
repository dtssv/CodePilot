/**
 * End-to-end check that the v2 envelope reducer + the typed ToolResultPayload
 * contract agree.
 *
 * Mirrors the test conventions in src/state/turnReducer.test.ts.
 *
 * Run:  npx tsx plugin/webui/src/components/tools/v2/toolResult.test.ts
 */

import { strict as assert } from 'node:assert';
import { INITIAL_V2_STATE, type EventEnvelope } from '../../../state/events';
import { reduceEnvelope } from '../../../state/turnReducer';
import type { ToolResultPayload } from './types';

let seq = 0;
const env = (type: string, turnId: string, stepId: string, payload: unknown, parent?: string): EventEnvelope => ({
    seq: ++seq, turnId, stepId, parentStepId: parent ?? null,
    ts: 1_700_000_000_000 + seq, type, payload,
});

// happy path: tool.call → tool.result(fs.read) → step.end
{
    seq = 0;
    let state = INITIAL_V2_STATE;
    state = reduceEnvelope(state, env('turn.start', 't1', 't1', { userMessage: 'show me x.ts' }));
    state = reduceEnvelope(state, env('step.start', 't1', 'llm1', { stepId: 'llm1', kind: 'llm', title: 'Reasoning' }));
    state = reduceEnvelope(state, env('step.start', 't1', 'tool1', { stepId: 'tool1', kind: 'tool', title: 'fs.read', parentStepId: 'llm1' }, 'llm1'));
    state = reduceEnvelope(state, env('tool.call', 't1', 'tool1', { stepId: 'tool1', tool: 'fs.read', args: { path: 'x.ts' } }));

    const fsReadPayload = {
        kind: 'fs.read',
        path: 'x.ts',
        lang: 'TypeScript',
        totalLines: 42,
        bytes: 1024,
        truncated: false,
        content: 'export const foo = 1;\n',
        range: null,
    } satisfies ToolResultPayload;

    state = reduceEnvelope(state, env('tool.result', 't1', 'tool1', { stepId: 'tool1', ok: true, result: fsReadPayload }));
    state = reduceEnvelope(state, env('step.end', 't1', 'tool1', { stepId: 'tool1', status: 'success' }));

    const step = state.steps['tool1'];
    assert.equal(step.status, 'success');
    assert.equal(step.toolResult?.ok, true);
    const r = step.toolResult?.result as ToolResultPayload;
    assert.equal(r.kind, 'fs.read');
    assert.equal((r as Extract<ToolResultPayload, { kind: 'fs.read' }>).path, 'x.ts');
    console.log('✓ fs.read result is preserved across envelopes');
}

// error path: tool.result with ok=false carries error payload via classifier kind=error
{
    seq = 0;
    let state = INITIAL_V2_STATE;
    state = reduceEnvelope(state, env('turn.start', 't2', 't2', { userMessage: 'rm -rf /' }));
    state = reduceEnvelope(state, env('step.start', 't2', 's1', { stepId: 's1', kind: 'tool', title: 'shell.exec' }));
    state = reduceEnvelope(state, env('tool.call', 't2', 's1', { stepId: 's1', tool: 'shell.exec', args: { command: 'rm -rf /' } }));
    const errPayload: ToolResultPayload = {
        kind: 'error',
        tool: 'shell.exec',
        errorCode: 'path_violation',
        errorMessage: 'denied: forbidden path',
    };
    state = reduceEnvelope(state, env('tool.result', 't2', 's1', { stepId: 's1', ok: false, result: errPayload, error: 'denied: forbidden path' }));
    state = reduceEnvelope(state, env('step.end', 't2', 's1', { stepId: 's1', status: 'error', error: 'denied: forbidden path' }));

    const step = state.steps['s1'];
    assert.equal(step.status, 'error');
    assert.equal(step.toolResult?.ok, false);
    const r = step.toolResult?.result as Extract<ToolResultPayload, { kind: 'error' }>;
    assert.equal(r.kind, 'error');
    assert.equal(r.errorCode, 'path_violation');
    console.log('✓ error path preserves kind=error + errorCode');
}

// grep path: many matches, classifier kind=grep
{
    seq = 0;
    let state = INITIAL_V2_STATE;
    state = reduceEnvelope(state, env('turn.start', 't3', 't3', {}));
    state = reduceEnvelope(state, env('step.start', 't3', 'g1', { stepId: 'g1', kind: 'tool', title: 'fs.grep' }));
    state = reduceEnvelope(state, env('tool.call', 't3', 'g1', { stepId: 'g1', tool: 'fs.grep', args: { pattern: 'TODO' } }));
    const grepPayload: Extract<ToolResultPayload, { kind: 'grep' }> = {
        kind: 'grep',
        pattern: 'TODO',
        matches: [
            { path: 'src/a.ts', line: 12, preview: '// TODO: refactor' },
            { path: 'src/b.ts', line: 33, preview: '// TODO: handle nulls' },
        ],
        total: 2,
        truncated: false,
    };
    state = reduceEnvelope(state, env('tool.result', 't3', 'g1', { stepId: 'g1', ok: true, result: grepPayload }));
    state = reduceEnvelope(state, env('step.end', 't3', 'g1', { stepId: 'g1', status: 'success' }));

    const r = state.steps['g1'].toolResult?.result as Extract<ToolResultPayload, { kind: 'grep' }>;
    assert.equal(r.kind, 'grep');
    assert.equal(r.matches.length, 2);
    assert.equal(r.matches[0].path, 'src/a.ts');
    console.log('✓ grep payload preserved');
}

console.log('\nAll tool.result self-checks passed.');
