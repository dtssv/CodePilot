import { useState } from 'react';
import { sendToPlugin } from '../bridge';
import { useTranslation } from '../i18n';
import { markNeedsInputSubmitted, useNeedsInputSubmitted } from '../state/needsInputStore';

/**
 * needs_input card — choice questions use option cards (auto-submit for single-choice / yes-no).
 * Free-text answers use the main chat input bar (see ChatInputSection), not an inline field.
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
    continuationToken?: string;
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
    const { t } = useTranslation();
    const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
    const [expandedOptions, setExpandedOptions] = useState<Record<string, boolean>>({});
    const [submitted, setSubmitted] = useState(false);
    const globallySubmitted = useNeedsInputSubmitted(payload.continuationToken);
    const isSubmitted = submitted || globallySubmitted;

    const hasChoiceQuestions = payload.questions.some(
        (q) => q.kind !== 'freeform' && (q.options?.length ?? 0) > 0,
    );
    const hasFreeformOnly = payload.questions.some(
        (q) => q.kind === 'freeform' || !(q.options?.length),
    );

    const handleSelectOption = (questionId: string, optionId: string, kind: string) => {
        if (isSubmitted) return;
        const newSelected = kind === 'multi-choice'
            ? {
                ...selectedOptions,
                [questionId]: ((selectedOptions[questionId] || []).includes(optionId)
                    ? (selectedOptions[questionId] || []).filter((id) => id !== optionId)
                    : [...(selectedOptions[questionId] || []), optionId]),
            }
            : { ...selectedOptions, [questionId]: [optionId] };
        setSelectedOptions(newSelected);

        if (kind === 'single-choice' || kind === 'yes-no') {
            setSubmitted(true);
            markNeedsInputSubmitted(payload.continuationToken);
            sendToPlugin('needs_input_response', {
                answers: [{ questionId, optionId }],
                continuationToken: payload.continuationToken || null,
            });
            onAnswered?.([{ questionId, optionId }]);
        }
    };

    const toggleExpand = (key: string) => {
        setExpandedOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    const buildAnswers = (): Answer[] => {
        const answers: Answer[] = [];
        for (const q of payload.questions) {
            const selected = selectedOptions[q.id];
            if (selected && selected.length > 0) {
                if (q.kind === 'multi-choice') {
                    for (const optionId of selected) {
                        answers.push({ questionId: q.id, optionId });
                    }
                } else {
                    answers.push({ questionId: q.id, optionId: selected[0] });
                }
            }
        }
        return answers;
    };

    const handleSubmit = () => {
        if (isSubmitted) return;
        const answers = buildAnswers();
        if (answers.length === 0) return;
        setSubmitted(true);
        markNeedsInputSubmitted(payload.continuationToken);
        sendToPlugin('needs_input_response', {
            answers,
            continuationToken: payload.continuationToken || null,
        });
        onAnswered?.(answers);
    };

    if (isSubmitted) {
        return <div className="needs-input-submitted">{t('chat.needsInputSubmitted')}</div>;
    }

    return (
        <div className="needs-input-card">
            <div className="needs-input-header">
                <h4>{payload.title || '需要你的确认'}</h4>
                {payload.reason && <p className="needs-input-reason">{payload.reason}</p>}
            </div>

            {payload.questions.map((q) => (
                <div key={q.id} className="needs-input-question">
                    <div className="question-header">
                        <span className="question-index">Q{q.index}</span>
                        <span className="question-prompt">{q.prompt}</span>
                        {q.required && <span className="question-required">*</span>}
                    </div>
                    {q.why && <p className="question-why">{q.why}</p>}

                    {(q.options?.length ?? 0) > 0 ? (
                        <div className="options-list">
                            {q.options?.map((opt) => {
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
                                            {opt.impact && (
                                                <span className={`impact-badge impact-${opt.impact}`}>{opt.impact}</span>
                                            )}
                                        </div>

                                        {(opt.pros || opt.cons) && (
                                            <button
                                                type="button"
                                                className="expand-btn"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleExpand(expandKey);
                                                }}
                                            >
                                                {isExpanded ? '▾' : '▸'} 详情
                                            </button>
                                        )}

                                        {isExpanded && (opt.pros || opt.cons) && (
                                            <div className="option-details">
                                                {opt.pros && opt.pros.length > 0 && (
                                                    <div className="pros">
                                                        {opt.pros.map((p, i) => (
                                                            <span key={i} className="pro-item">+ {p}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                {opt.cons && opt.cons.length > 0 && (
                                                    <div className="cons">
                                                        {opt.cons.map((c, i) => (
                                                            <span key={i} className="con-item">- {c}</span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : null}
                </div>
            ))}

            {(hasFreeformOnly || payload.freeformAllowed) && !hasChoiceQuestions && (
                <p className="needs-input-chat-hint">{t('chat.needsInputUseChatHint')}</p>
            )}

            {hasChoiceQuestions && (hasFreeformOnly || payload.freeformAllowed) && (
                <p className="needs-input-chat-hint muted">{t('chat.needsInputUseChatHint')}</p>
            )}

            {payload.notesForUser && payload.notesForUser.length > 0 && (
                <div className="notes-section">
                    {payload.notesForUser.map((note, i) => (
                        <p key={i} className="note-item">💡 {note}</p>
                    ))}
                </div>
            )}

            {payload.questions.some((q) => q.kind === 'multi-choice') && (
                <div className="needs-input-actions">
                    <button type="button" className="submit-btn" onClick={handleSubmit}>
                        提交回答
                    </button>
                </div>
            )}
        </div>
    );
}
