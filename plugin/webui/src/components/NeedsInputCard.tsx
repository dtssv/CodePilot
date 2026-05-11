import { useState } from 'react';
import { sendToPlugin } from '../bridge';

/**
 * Full-featured needs_input card matching the design spec in 05-接口文档.md §3.2.1.
 *
 * Supports:
 * - Multiple questions with different kinds (single-choice, multi-choice, yes-no, freeform)
 * - Options with impact/pros/cons details
 * - Default option highlighting
 * - Free-form text input for answering by number or free text
 * - Submit all answers at once as structured answers[]
 */
interface Question {
    id: string;
    index: number;
    prompt: string;
    why?: string;
    kind: 'single-choice' | 'multi-choice' | 'yes-no' | 'freeform';
    required: boolean;
    defaultOptionId?: string;
    options?: Option[];
    placeholder?: string;
}

interface Option {
    id: string;
    label: string;
    impact?: string;
    pros?: string[];
    cons?: string[];
}

interface NeedsInputPayload {
    title: string;
    reason: string;
    blocking: boolean;
    maxAnswers?: number;
    freeformAllowed: boolean;
    questions: Question[];
    notesForUser?: string[];
}

interface NeedsInputCardProps {
    payload: NeedsInputPayload;
    onAnswered?: (answers: Answer[]) => void;
}

interface Answer {
    questionId?: string;
    optionId?: string;
    freeform?: string;
}

export function NeedsInputCard({ payload, onAnswered }: NeedsInputCardProps) {
    const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
    const [freeformText, setFreeformText] = useState('');
    const [expandedOptions, setExpandedOptions] = useState<Record<string, boolean>>({});
    const [submitted, setSubmitted] = useState(false);

    const handleSelectOption = (questionId: string, optionId: string, kind: string) => {
        if (submitted) return;
        setSelectedOptions(prev => {
            if (kind === 'multi-choice') {
                const current = prev[questionId] || [];
                const next = current.includes(optionId)
                    ? current.filter(id => id !== optionId)
                    : [...current, optionId];
                return { ...prev, [questionId]: next };
            }
            // single-choice / yes-no
            return { ...prev, [questionId]: [optionId] };
        });
    };

    const toggleExpand = (key: string) => {
        setExpandedOptions(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const buildAnswers = (): Answer[] => {
        // First check if user typed free-form text
        if (freeformText.trim()) {
            return parseFreeformAnswers(freeformText, payload.questions);
        }

        // Build answers from selected options
        const answers: Answer[] = [];
        for (const q of payload.questions) {
            const selected = selectedOptions[q.id];
            if (selected && selected.length > 0) {
                if (q.kind === 'multi-choice') {
                    // For multi-choice, submit the first selected as primary
                    answers.push({ questionId: q.id, optionId: selected[0] });
                    // Additional selections as freeform
                    for (let i = 1; i < selected.length; i++) {
                        answers.push({ questionId: q.id, optionId: selected[i] });
                    }
                } else {
                    answers.push({ questionId: q.id, optionId: selected[0] });
                }
            } else if (q.kind === 'freeform') {
                // Freeform questions should be answered via the text field
                // (handled by parseFreeformAnswers)
            }
        }
        return answers;
    };

    const handleSubmit = () => {
        if (submitted) return;
        const answers = buildAnswers();
        setSubmitted(true);

        // Send to plugin which will call /v1/conversation/run with intent=answer
        sendToPlugin('needs_input_response', {
            answers,
            continuationToken: null, // Will be filled by the plugin
        });

        onAnswered?.(answers);
    };

    return (
        <div className="needs-input-card">
            <div className="needs-input-header">
                <h4>{payload.title || '需要你的确认'}</h4>
                {payload.reason && <p className="needs-input-reason">{payload.reason}</p>}
            </div>

            {payload.questions.map(q => (
                <div key={q.id} className="needs-input-question">
                    <div className="question-header">
                        <span className="question-index">Q{q.index}</span>
                        <span className="question-prompt">{q.prompt}</span>
                        {q.required && <span className="question-required">*</span>}
                    </div>
                    {q.why && <p className="question-why">{q.why}</p>}

                    {q.kind === 'freeform' ? (
                        <input
                            type="text"
                            className="freeform-input"
                            placeholder={q.placeholder || 'Type your answer...'}
                            disabled={submitted}
                            onChange={e => {
                                if (!submitted) {
                                    setSelectedOptions(prev => ({
                                        ...prev,
                                        [q.id]: [e.target.value]
                                    }));
                                }
                            }}
                        />
                    ) : (
                        <div className="options-list">
                            {q.options?.map(opt => {
                                const isSelected = (selectedOptions[q.id] || []).includes(opt.id);
                                const isDefault = q.defaultOptionId === opt.id;
                                const expandKey = `${q.id}-${opt.id}`;
                                const isExpanded = expandedOptions[expandKey];

                                return (
                                    <div
                                        key={opt.id}
                                        className={`option-card ${isSelected ? 'selected' : ''} ${isDefault ? 'default' : ''}`}
                                        onClick={() => handleSelectOption(q.id, opt.id, q.kind)}
                                    >
                                        <div className="option-header">
                                            <span className={`option-radio ${isSelected ? 'checked' : ''}`} />
                                            <span className="option-label">{opt.label}</span>
                                            {isDefault && <span className="default-badge">推荐</span>}
                                            {opt.impact && <span className={`impact-badge impact-${opt.impact}`}>{opt.impact}</span>}
                                        </div>

                                        {(opt.pros || opt.cons) && (
                                            <button
                                                className="expand-btn"
                                                onClick={e => { e.stopPropagation(); toggleExpand(expandKey); }}
                                            >
                                                {isExpanded ? '▾' : '▸'} 详情
                                            </button>
                                        )}

                                        {isExpanded && (opt.pros || opt.cons) && (
                                            <div className="option-details">
                                                {opt.pros && opt.pros.length > 0 && (
                                                    <div className="pros">
                                                        {opt.pros.map((p, i) => <span key={i} className="pro-item">+ {p}</span>)}
                                                    </div>
                                                )}
                                                {opt.cons && opt.cons.length > 0 && (
                                                    <div className="cons">
                                                        {opt.cons.map((c, i) => <span key={i} className="con-item">- {c}</span>)}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            ))}

            {payload.freeformAllowed && (
                <div className="freeform-section">
                    <p className="freeform-label">或者直接输入你的回答（支持 "1: b; 2: a; 3: 600" 格式）：</p>
                    <textarea
                        className="freeform-textarea"
                        placeholder="输入你的回答..."
                        value={freeformText}
                        onChange={e => setFreeformText(e.target.value)}
                        disabled={submitted}
                        rows={2}
                    />
                </div>
            )}

            {payload.notesForUser && payload.notesForUser.length > 0 && (
                <div className="notes-section">
                    {payload.notesForUser.map((note, i) => (
                        <p key={i} className="note-item">💡 {note}</p>
                    ))}
                </div>
            )}

            <div className="needs-input-actions">
                <button
                    className="submit-btn"
                    onClick={handleSubmit}
                    disabled={submitted}
                >
                    {submitted ? '已提交' : '提交回答'}
                </button>
            </div>
        </div>
    );
}

/**
 * Parse free-form text answers like "1: b; 2: a; 3: 600" into structured answers.
 * Falls back to a single freeform answer if parsing fails.
 */
function parseFreeformAnswers(text: string, questions: Question[]): Answer[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    // Try to parse "1: b; 2: a; 3: 600" format
    const numberedPattern = /(\d+)\s*[:：]\s*([^;；]+)/g;
    const answers: Answer[] = [];
    let match;
    let hasNumbered = false;

    while ((match = numberedPattern.exec(trimmed)) !== null) {
        hasNumbered = true;
        const index = parseInt(match[1], 10);
        const value = match[2].trim();
        const question = questions.find(q => q.index === index);

        if (question) {
            // Check if value matches an option id
            const matchingOption = question.options?.find(o => o.id === value);
            if (matchingOption) {
                answers.push({ questionId: question.id, optionId: value });
            } else {
                answers.push({ questionId: question.id, freeform: value });
            }
        }
    }

    // If no numbered pattern found, treat entire text as a freeform answer
    if (!hasNumbered) {
        answers.push({ questionId: '', freeform: trimmed });
    }

    return answers;
}