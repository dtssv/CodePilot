import { useEffect, useState } from 'react';
import { onPluginEvent } from '../bridge';

interface PlanStep {
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed';
}

interface LedgerEntry {
    key: string;
    value: string;
}

export function PlanPanel() {
    const [steps, setSteps] = useState<PlanStep[]>([]);
    const [ledger, setLedger] = useState<LedgerEntry[]>([]);

    useEffect(() => {
        const unsubs = [
            onPluginEvent('plan', (p) => {
                const { steps: newSteps } = p as { steps: PlanStep[] };
                setSteps(newSteps);
            }),
            onPluginEvent('plan_delta', (p) => {
                const delta = p as { stepId: string; status: PlanStep['status'] };
                setSteps((prev) =>
                    prev.map((s) => (s.id === delta.stepId ? { ...s, status: delta.status } : s)),
                );
            }),
            onPluginEvent('task_ledger', (p) => {
                const { entries } = p as { entries: LedgerEntry[] };
                setLedger(entries);
            }),
        ];
        return () => unsubs.forEach((u) => u());
    }, []);

    const statusIcon = (s: PlanStep['status']) => {
        switch (s) {
            case 'done': return '✓';
            case 'in_progress': return '⟳';
            case 'failed': return '✗';
            default: return '○';
        }
    };

    return (
        <div className="plan-panel">
            <h3>Plan</h3>
            <ul className="plan-steps">
                {steps.map((step) => (
                    <li key={step.id} className={`plan-step step-${step.status}`}>
                        <span className="step-icon">{statusIcon(step.status)}</span>
                        <span className="step-title">{step.title}</span>
                    </li>
                ))}
            </ul>
            {ledger.length > 0 && (
                <>
                    <h3>Task Ledger</h3>
                    <dl className="ledger-list">
                        {ledger.map((e, i) => (
                            <div key={i} className="ledger-entry">
                                <dt>{e.key}</dt>
                                <dd>{e.value}</dd>
                            </div>
                        ))}
                    </dl>
                </>
            )}
        </div>
    );
}