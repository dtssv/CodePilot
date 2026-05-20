import { describe, expect, it } from 'vitest';
import type { StepNode } from '../state/events';
import { sortStepsChronologically } from './timelineSort';

function step(id: string, partial: Partial<StepNode>): StepNode {
    return {
        stepId: id,
        kind: 'tool',
        title: id,
        status: 'success',
        startedAt: 1000,
        textBuf: '',
        thinkingBuf: '',
        children: [],
        ...partial,
    };
}

describe('sortStepsChronologically', () => {
    it('orders by orderSeq when startedAt ties', () => {
        const steps: Record<string, StepNode> = {
            llm: step('llm', { orderSeq: 30, kind: 'llm', startedAt: 1000 }),
            shell1: step('shell1', { orderSeq: 10, startedAt: 1000 }),
            shell2: step('shell2', { orderSeq: 20, startedAt: 1000 }),
        };
        const ids = ['llm', 'shell1', 'shell2'];
        const sorted = sortStepsChronologically(ids, steps).map((s) => s.stepId);
        expect(sorted).toEqual(['shell1', 'shell2', 'llm']);
    });

    it('falls back to startedAt then insertion index', () => {
        const steps: Record<string, StepNode> = {
            a: step('a', { startedAt: 200 }),
            b: step('b', { startedAt: 100 }),
            c: step('c', { startedAt: 100 }),
        };
        const ids = ['a', 'b', 'c'];
        const sorted = sortStepsChronologically(ids, steps).map((s) => s.stepId);
        expect(sorted).toEqual(['b', 'c', 'a']);
    });
});
