import { useEffect, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';

interface PlanStep {
    id: string;
    title: string;
    intent?: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
    riskLevel?: 'low' | 'medium' | 'high';
    tools?: string[];
    expectedOutcome?: string;
    dependsOn?: string[];
}

interface Plan {
    goal: string;
    assumptions?: string[];
    constraints?: string[];
    steps: PlanStep[];
    successDefinition?: string[];
}

interface TaskLedger {
    goal: string;
    subtasks: { id: string; title: string; status: string; why?: string }[];
    cursor: string;
    notes: string[];
    blockers: string[];
}

/**
 * Agent mode Plan & Task Ledger panel.
 * Features:
 * - Step tree with expand/collapse
 * - Status badges (pending/running/success/failed) with color coding
 * - Risk level indicators
 * - Tool icons per step
 * - Accept/Skip/Replan buttons
 * - Task Ledger: goal + subtasks + cursor highlight + notes
 * - Continue / Answer / Replan quick actions
 */
export function PlanPanel() {
    const [plan, setPlan] = useState<Plan | null>(null);
    const [ledger, setLedger] = useState<TaskLedger | null>(null);
    const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState<'plan' | 'ledger'>('plan');

    useEffect(() => {
        const unsubs = [
            onPluginEvent('plan', (data) => setPlan(data as Plan)),
            onPluginEvent('plan_delta', (data) => {
                setPlan(prev => prev ? applyPlanDelta(prev, data) : prev);
            }),
            onPluginEvent('task_ledger', (data) => setLedger(data as TaskLedger)),
        ];
        return () => unsubs.forEach(u => u());
    }, []);

    if (!plan && !ledger) return null;

    const toggleStep = (id: string) => {
        setExpandedSteps(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const statusColors: Record<string, string> = {
        pending: '#888', running: '#58a6ff', success: '#3fb950',
        failed: '#f85149', skipped: '#8b949e', cancelled: '#8b949e',
    };
    const statusIcons: Record<string, string> = {
        pending: '○', running: '◉', success: '✓', failed: '✗', skipped: '⊘', cancelled: '⊘',
    };
    const riskColors: Record<string, string> = { low: '#3fb950', medium: '#d29922', high: '#f85149' };

    return (
        <div style={{ borderLeft: '1px solid var(--border-color, #333)', padding: '8px', fontSize: '13px', overflowY: 'auto', height: '100%' }}>
            {/* Tab bar */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '8px', borderBottom: '1px solid #333', paddingBottom: '4px' }}>
                <button onClick={() => setActiveTab('plan')} style={{
                    background: activeTab === 'plan' ? 'var(--accent, #58a6ff)' : 'transparent',
                    color: activeTab === 'plan' ? '#fff' : '#aaa', border: 'none', borderRadius: '4px',
                    padding: '4px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                }}>计划</button>
                <button onClick={() => setActiveTab('ledger')} style={{
                    background: activeTab === 'ledger' ? 'var(--accent, #58a6ff)' : 'transparent',
                    color: activeTab === 'ledger' ? '#fff' : '#aaa', border: 'none', borderRadius: '4px',
                    padding: '4px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                }}>任务</button>
            </div>

            {activeTab === 'plan' && plan && (
                <div>
                    {/* Goal */}
                    <div style={{ fontWeight: 600, marginBottom: '8px', color: '#cdd6f4' }}>{plan.goal}</div>
                    {plan.assumptions && plan.assumptions.length > 0 && (
                        <div style={{ fontSize: '11px', color: '#888', marginBottom: '8px' }}>
                            假设: {plan.assumptions.join('; ')}
                        </div>
                    )}

                    {/* Steps */}
                    {plan.steps.map(step => (
                        <div key={step.id} style={{
                            margin: '4px 0', borderRadius: '6px',
                            border: `1px solid ${step.status === 'running' ? '#58a6ff44' : '#333'}`,
                            background: step.status === 'running' ? '#58a6ff0a' : 'transparent',
                        }}>
                            {/* Step header */}
                            <div
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', cursor: 'pointer' }}
                                onClick={() => toggleStep(step.id)}
                            >
                                <span style={{ color: statusColors[step.status] || '#888', fontSize: '12px', width: '16px', textAlign: 'center' }}>
                                    {statusIcons[step.status] || '○'}
                                </span>
                                <span style={{ flex: 1, color: '#cdd6f4', fontSize: '12px' }}>{step.title}</span>
                                {step.riskLevel && (
                                    <span style={{
                                        fontSize: '10px', padding: '1px 5px', borderRadius: '3px',
                                        background: `${riskColors[step.riskLevel]}22`, color: riskColors[step.riskLevel],
                                    }}>{step.riskLevel}</span>
                                )}
                                <span style={{ fontSize: '10px', color: '#666' }}>{expandedSteps.has(step.id) ? '▼' : '▶'}</span>
                            </div>

                            {/* Step details (expanded) */}
                            {expandedSteps.has(step.id) && (
                                <div style={{ padding: '4px 8px 8px 30px', fontSize: '11px', color: '#888' }}>
                                    {step.intent && <div>目的: {step.intent}</div>}
                                    {step.expectedOutcome && <div>预期: {step.expectedOutcome}</div>}
                                    {step.tools && step.tools.length > 0 && (
                                        <div>工具: {step.tools.map(t => (
                                            <span key={t} style={{ background: '#333', padding: '1px 5px', borderRadius: '3px', marginRight: '4px', fontSize: '10px' }}>{t}</span>
                                        ))}</div>
                                    )}
                                    {step.dependsOn && step.dependsOn.length > 0 && (
                                        <div>依赖: {step.dependsOn.join(', ')}</div>
                                    )}
                                    {/* Action buttons for pending steps */}
                                    {step.status === 'pending' && (
                                        <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                                            <button onClick={() => sendToPlugin('plan_edit', { op: 'skip', stepId: step.id })}
                                                style={btnStyle('#8b949e')}>跳过</button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}

                    {/* Plan actions */}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '12px', paddingTop: '8px', borderTop: '1px solid #333' }}>
                        <button onClick={() => sendToPlugin('continue_run', {})} style={btnStyle('#58a6ff')}>继续</button>
                        <button onClick={() => sendToPlugin('replan', {})} style={btnStyle('#d29922')}>重新规划</button>
                    </div>
                </div>
            )}

            {activeTab === 'ledger' && ledger && (
                <div>
                    {/* Goal */}
                    <div style={{ fontWeight: 600, marginBottom: '8px', color: '#cdd6f4' }}>{ledger.goal}</div>

                    {/* Subtasks */}
                    {ledger.subtasks.map(st => (
                        <div key={st.id} style={{
                            display: 'flex', alignItems: 'center', gap: '6px',
                            padding: '6px 8px', margin: '4px 0', borderRadius: '6px',
                            border: st.id === ledger.cursor ? '1px solid #58a6ff55' : '1px solid #333',
                            background: st.id === ledger.cursor ? '#58a6ff0a' : 'transparent',
                        }}>
                            <span style={{
                                color: st.status === 'done' ? '#3fb950' : st.status === 'in_progress' ? '#58a6ff' : st.status === 'blocked' ? '#f85149' : '#888',
                                fontSize: '12px', width: '16px', textAlign: 'center',
                            }}>
                                {st.status === 'done' ? '✓' : st.status === 'in_progress' ? '◉' : st.status === 'blocked' ? '⚠' : '○'}
                            </span>
                            <div style={{ flex: 1 }}>
                                <div style={{ color: '#cdd6f4', fontSize: '12px' }}>{st.title}</div>
                                {st.why && <div style={{ fontSize: '11px', color: '#666' }}>{st.why}</div>}
                            </div>
                            {st.id === ledger.cursor && (
                                <span style={{ fontSize: '10px', color: '#58a6ff', background: '#58a6ff22', padding: '1px 5px', borderRadius: '3px' }}>当前</span>
                            )}
                        </div>
                    ))}

                    {/* Notes */}
                    {ledger.notes.length > 0 && (
                        <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid #333' }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: '#888', marginBottom: '4px' }}>备注</div>
                            {ledger.notes.map((note, i) => (
                                <div key={i} style={{ fontSize: '11px', color: '#aaa', margin: '2px 0' }}>• {note}</div>
                            ))}
                        </div>
                    )}

                    {/* Blockers */}
                    {ledger.blockers.length > 0 && (
                        <div style={{ marginTop: '8px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: '#f85149', marginBottom: '4px' }}>阻塞项</div>
                            {ledger.blockers.map((b, i) => (
                                <div key={i} style={{ fontSize: '11px', color: '#f85149', margin: '2px 0' }}>⚠ {b}</div>
                            ))}
                        </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '12px', paddingTop: '8px', borderTop: '1px solid #333' }}>
                        <button onClick={() => sendToPlugin('continue_run', {})} style={btnStyle('#58a6ff')}>继续</button>
                        <button onClick={() => sendToPlugin('answer_input', {})} style={btnStyle('#3fb950')}>回答</button>
                    </div>
                </div>
            )}
        </div>
    );
}

function btnStyle(color: string): React.CSSProperties {
    return {
        background: `${color}22`, color, border: `1px solid ${color}44`,
        borderRadius: '4px', padding: '4px 12px', cursor: 'pointer', fontSize: '11px', fontWeight: 600,
    };
}

function applyPlanDelta(plan: Plan, delta: unknown): Plan {
    const d = delta as { ops?: { op: string; stepId?: string; status?: string;[key: string]: unknown }[] };
    if (!d.ops) return plan;
    const steps = [...plan.steps];
    for (const op of d.ops) {
        if (op.op === 'markStatus' && op.stepId) {
            const idx = steps.findIndex(s => s.id === op.stepId);
            if (idx >= 0 && op.status) steps[idx] = { ...steps[idx], status: op.status as PlanStep['status'] };
        } else if (op.op === 'add') {
            steps.push(op as unknown as PlanStep);
        } else if (op.op === 'skip' && op.stepId) {
            const idx = steps.findIndex(s => s.id === op.stepId);
            if (idx >= 0) steps[idx] = { ...steps[idx], status: 'skipped' };
        }
    }
    return { ...plan, steps };
}