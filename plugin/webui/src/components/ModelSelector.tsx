import { useEffect, useRef, useState } from 'react';

interface ModelOption {
    id: string;
    name: string;
    type: 'system' | 'custom';
    tier?: 'FAST' | 'DEFAULT' | 'THINKING' | 'PREMIUM';
    capabilities?: string[];
}

interface ModelSelectorProps {
    models: ModelOption[];
    selectedModelId: string;
    onSelect: (id: string) => void;
    lastRoute?: { name?: string; tier?: string; reason?: string } | null;
}

export function ModelSelector({ models, selectedModelId, onSelect, lastRoute }: ModelSelectorProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const systemModels = models.filter(m => m.type === 'system');
    const customModels = models.filter(m => m.type === 'custom');
    const selected = models.find(m => m.id === selectedModelId);
    const displayLabel = selectedModelId === 'auto'
        ? `Auto${lastRoute?.name ? ` -> ${lastRoute.name}` : ''}`
        : selected ? selected.name : 'Auto';

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <div className="model-selector" ref={ref}>
            <button
                className="model-selector-trigger"
                onClick={() => setOpen(!open)}
                title="Select model"
            >
                <span className="model-selector-label">{displayLabel}</span>
                <span className="model-selector-chevron">{open ? '▴' : '▾'}</span>
            </button>
            {open && (
                <div className="model-selector-dropdown">
                    {systemModels.length > 0 && (
                        <>
                            <div
                                className={`model-option ${selectedModelId === 'auto' ? 'selected' : ''}`}
                                onClick={() => { onSelect('auto'); setOpen(false); }}
                            >
                                <span className="model-option-radio">{selectedModelId === 'auto' ? '●' : '○'}</span>
                                <span className="model-option-name">Auto{lastRoute?.tier ? ` (${lastRoute.tier})` : ''}</span>
                                {lastRoute?.reason && <span className="model-option-tier">{lastRoute.reason}</span>}
                            </div>
                            <div className="model-group-label">System Models</div>
                            {systemModels.map(m => (
                                <div
                                    key={m.id}
                                    className={`model-option ${m.id === selectedModelId ? 'selected' : ''}`}
                                    onClick={() => { onSelect(m.id); setOpen(false); }}
                                >
                                    <span className="model-option-radio">{m.id === selectedModelId ? '●' : '○'}</span>
                                    <span className="model-option-name">{m.name}</span>
                                    {m.tier && <span className="model-option-tier">{m.tier}</span>}
                                </div>
                            ))}
                        </>
                    )}
                    {systemModels.length > 0 && customModels.length > 0 && (
                        <div className="model-divider" />
                    )}
                    {customModels.length > 0 && (
                        <>
                            <div className="model-group-label">Custom Models</div>
                            {customModels.map(m => (
                                <div
                                    key={m.id}
                                    className={`model-option ${m.id === selectedModelId ? 'selected' : ''}`}
                                    onClick={() => { onSelect(m.id); setOpen(false); }}
                                >
                                    <span className="model-option-radio">{m.id === selectedModelId ? '●' : '○'}</span>
                                    <span className="model-option-name">{m.name}</span>
                                    {m.tier && <span className="model-option-tier">{m.tier}</span>}
                                </div>
                            ))}
                        </>
                    )}
                    {models.length === 0 && (
                        <div className="model-option-empty">No models available</div>
                    )}
                </div>
            )}
        </div>
    );
}