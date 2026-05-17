import { useEffect, useMemo, useState } from 'react';
import type { SlashCommand } from './commands';

interface Props {
    query: string;
    commands: SlashCommand[];
    anchorRect?: DOMRect;
    onSelect: (command: SlashCommand) => void;
    onClose: () => void;
}

export function SlashPopup({ query, commands, anchorRect, onSelect, onClose }: Props) {
    const [idx, setIdx] = useState(0);
    const filtered = useMemo(() => {
        const q = query.toLowerCase();
        return commands.filter((c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q)));
    }, [commands, query]);

    useEffect(() => setIdx(0), [query]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(filtered.length - 1, i + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                if (filtered[idx]) onSelect(filtered[idx]);
            }
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [filtered, idx, onSelect, onClose]);

    if (filtered.length === 0) return null;
    return (
        <div className="slash-popup" style={{ position: 'absolute', left: anchorRect?.left ?? 16, bottom: '100%', zIndex: 1000 }}>
            {filtered.map((cmd, i) => (
                <div key={cmd.name} className={`slash-item ${i === idx ? 'active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => onSelect(cmd)}>
                    <span className="slash-name">/{cmd.name}</span>
                    <span className="slash-desc">{cmd.description}</span>
                </div>
            ))}
        </div>
    );
}
