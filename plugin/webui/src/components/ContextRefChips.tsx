const REF_ICONS: Record<string, string> = {
    code: '{ }',
    file: '📄',
    package: '📦',
    folder: '📁',
    symbol: '🔤',
    git: '🔀',
    codebase: '🔍',
    docs: '📚',
    web: '🌐',
    terminal: '💻',
    rule: '📜',
};

export interface ContextRefChip {
    id?: string;
    display?: string;
    type?: string;
}

export function ContextRefChips({ refs, className = 'turn-context-refs' }: { refs: ContextRefChip[]; className?: string }) {
    if (!refs.length) return null;
    return (
        <div className={className} aria-label="Context references">
            {refs.map((c, i) => {
                const type = c.type ?? 'file';
                const icon = REF_ICONS[type] ?? '📎';
                return (
                    <span key={c.id ?? c.display ?? i} className={`ref-chip ref-type-${type}`} title={type}>
                        <span className="ref-chip-icon" aria-hidden>{icon}</span>
                        {c.display}
                    </span>
                );
            })}
        </div>
    );
}
