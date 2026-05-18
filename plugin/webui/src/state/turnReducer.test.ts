/**
 * Lightweight self-checks for the v2 turn reducer.
 *
 * The project doesn't currently ship a test runner; this file is designed to
 * run as a plain Node ESM module:
 *
 *   npx tsx plugin/webui/src/state/turnReducer.test.ts
 *
 * If/when a test runner is introduced, the assertions below port cleanly to
 * Vitest/Jest with no changes — every check uses `assert` from `node:assert`.
 */

import { strict as assert } from 'node:assert';
import { INITIAL_V2_STATE, type EventEnvelope } from './events';
import { applyEnvelope, reduceEnvelope } from './turnReducer';

let seq = 0;
const env = (type: string, turnId: string, stepId: string, payload: unknown, parentStepId?: string): EventEnvelope => ({
    seq: ++seq,
    turnId,
    stepId,
    parentStepId: parentStepId ?? null,
    ts: 1_700_000_000_000 + seq,
    type,
    payload,
});

// ---------- happy path: one turn, one llm step, one tool step ----------
{
    seq = 0;
    const events: EventEnvelope[] = [
        env('turn.start', 't1', 't1', { userMessage: 'hello', contextRefs: [] }),
        env('step.start', 't1', 't1-llm-1', { stepId: 't1-llm-1', kind: 'llm', title: 'Reasoning' }),
        env('text.delta', 't1', 't1-llm-1', { stepId: 't1-llm-1', text: 'hi ' }),
        env('text.delta', 't1', 't1-llm-1', { stepId: 't1-llm-1', text: 'there' }),
        env('step.start', 't1', 't1-tool-2', { stepId: 't1-tool-2', kind: 'tool', title: 'fs.read', parentStepId: 't1-llm-1' }, 't1-llm-1'),
        env('tool.call', 't1', 't1-tool-2', { stepId: 't1-tool-2', tool: 'fs.read', args: { path: 'x.ts' } }),
        env('tool.result', 't1', 't1-tool-2', { stepId: 't1-tool-2', ok: true, result: { lines: 3 } }),
        env('step.end', 't1', 't1-tool-2', { stepId: 't1-tool-2', status: 'success' }),
        env('step.end', 't1', 't1-llm-1', { stepId: 't1-llm-1', status: 'success' }),
        env('turn.end', 't1', 't1', { turnId: 't1', status: 'final', reason: 'final' }),
        env('turn.metrics', 't1', 't1', { inputTokens: 100, outputTokens: 50, costUsd: 0.01, modelId: 'gpt-4o' }),
    ];
    let state = INITIAL_V2_STATE;
    for (const ev of events) state = reduceEnvelope(state, ev);

    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0].status, 'final');
    assert.equal(state.turns[0].userMessage, 'hello');
    assert.deepEqual(state.turns[0].rootStepIds, ['t1-llm-1']);
    assert.deepEqual(state.turns[0].stepIds, ['t1-llm-1', 't1-tool-2']);
    assert.equal(state.steps['t1-llm-1'].textBuf, 'hi there');
    assert.equal(state.steps['t1-llm-1'].status, 'success');
    assert.deepEqual(state.steps['t1-llm-1'].children, ['t1-tool-2']);
    assert.equal(state.steps['t1-tool-2'].toolCall?.tool, 'fs.read');
    assert.equal(state.steps['t1-tool-2'].toolResult?.ok, true);
    assert.equal(state.steps['t1-tool-2'].status, 'success');
    assert.equal(state.turns[0].tokenMeta?.inputTokens, 100);
    assert.equal(state.turns[0].tokenMeta?.outputTokens, 50);
    console.log('✓ happy path');
}

// ---------- duplicate seq is ignored ----------
{
    seq = 0;
    const a = env('turn.start', 't2', 't2', { userMessage: 'x' });
    let state = INITIAL_V2_STATE;
    state = reduceEnvelope(state, a);
    const before = state;
    state = reduceEnvelope(state, a); // same seq
    assert.equal(state, before, 'reducer must short-circuit duplicates');
    console.log('✓ duplicate seq ignored');
}

// ---------- out-of-order: applyEnvelope buffers and requests replay ----------
{
    seq = 0;
    const a = env('turn.start', 't3', 't3', { userMessage: 'q' });           // seq 1
    const b = env('step.start', 't3', 't3-llm-1', { stepId: 't3-llm-1', kind: 'llm' }); // seq 2
    const c = env('text.delta', 't3', 't3-llm-1', { stepId: 't3-llm-1', text: 'hi' });  // seq 3
    let state = INITIAL_V2_STATE;

    let r = applyEnvelope(state, a); state = r.next;
    assert.equal(state.lastSeq, 1);

    // Skip b — feed c first
    r = applyEnvelope(state, c);
    state = r.next;
    assert.equal(state.lastSeq, 1, 'gap should hold lastSeq');
    assert.equal(state.pending.length, 1);
    assert.equal(r.requestReplayFrom, 1, 'should ask host to replay from lastSeq');

    // Now feed b: it should apply AND drain c from pending
    r = applyEnvelope(state, b);
    state = r.next;
    assert.equal(state.lastSeq, 3);
    assert.equal(state.pending.length, 0);
    assert.equal(state.steps['t3-llm-1']?.textBuf, 'hi');
    console.log('✓ out-of-order buffering & drain');
}

// ---------- step.end on unknown step is a no-op ----------
{
    seq = 0;
    let state = INITIAL_V2_STATE;
    state = reduceEnvelope(state, env('turn.start', 't4', 't4', {}));
    state = reduceEnvelope(state, env('step.end', 't4', 'ghost', { stepId: 'ghost', status: 'success' }));
    assert.equal(Object.keys(state.steps).length, 0);
    console.log('✓ step.end on unknown step is no-op');
}

// ---------- terminal step.end is sticky ----------
{
    seq = 0;
    let state = INITIAL_V2_STATE;
    state = reduceEnvelope(state, env('turn.start', 't5', 't5', {}));
    state = reduceEnvelope(state, env('step.start', 't5', 's1', { stepId: 's1', kind: 'llm', title: '' }));
    state = reduceEnvelope(state, env('step.end', 't5', 's1', { stepId: 's1', status: 'error', error: 'boom' }));
    const before = state.steps['s1'];
    state = reduceEnvelope(state, env('step.end', 't5', 's1', { stepId: 's1', status: 'success' }));
    assert.equal(state.steps['s1'], before, 'second terminal end must not overwrite');
    assert.equal(state.steps['s1'].status, 'error');
    console.log('✓ terminal status sticky');
}

console.log('\nAll v2 reducer self-checks passed.');
