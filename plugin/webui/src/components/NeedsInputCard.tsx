import { useState } from 'react';
import { sendToPlugin } from '../bridge';

interface NeedsInputCardProps {
    question: string;
    options: string[];
}

export function NeedsInputCard({ question, options }: NeedsInputCardProps) {
    const [selected, setSelected] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);

    const handleSelect = (opt: string) => {
        if (submitted) return;
        setSelected(opt);
        setSubmitted(true);
        sendToPlugin('needs_input_response', { answer: opt });
    };

    return (
        <div className="needs-input-card">
            <p className="needs-input-question">{question}</p>
            <div className="needs-input-options">
                {options.map((opt, i) => (
                    <button
                        key={i}
                        className={`option-btn ${selected === opt ? 'selected' : ''}`}
                        onClick={() => handleSelect(opt)}
                        disabled={submitted}
                    >
                        {opt}
                    </button>
                ))}
            </div>
        </div>
    );
}