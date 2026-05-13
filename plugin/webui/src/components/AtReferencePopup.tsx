import { useCallback, useEffect, useRef, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';

interface AtSuggestion {
    type: string; // "file" | "folder" | "symbol" | "git" | "codebase" | "docs" | "web" | "terminal" | "notepad"
    label: string;
    detail: string;
    path?: string;
}

interface AtReferencePopupProps {
    inputValue: string;
    cursorPosition: number;
    visible: boolean;
    onSelect: (suggestion: AtSuggestion) => void;
    onClose: () => void;
    anchorRect?: DOMRect;
}

/**
 * Popup dropdown for @-references in the chat input.
 * Triggered when user types '@' — shows file/folder/symbol/git/codebase/docs/web/terminal options.
 * Communicates with the plugin's AtReferenceProvider for search results.
 */
export function AtReferencePopup({ inputValue, cursorPosition, visible, onSelect, onClose, anchorRect }: AtReferencePopupProps) {
    const [suggestions, setSuggestions] = useState<AtSuggestion[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [loading, setLoading] = useState(false);
    const popupRef = useRef<HTMLDivElement>(null);

    // Extract the @-query from the input
    const getAtQuery = useCallback((): string => {
        const textBeforeCursor = inputValue.substring(0, cursorPosition);
        const atIndex = textBeforeCursor.lastIndexOf('@');
        if (atIndex === -1) return '';
        return textBeforeCursor.substring(atIndex + 1);
    }, [inputValue, cursorPosition]);

    // Fetch suggestions from plugin
    useEffect(() => {
        if (!visible) return;

        const query = getAtQuery();
        setLoading(true);
        sendToPlugin('at_suggest', { query }).catch(() => { });

        const unsub = onPluginEvent('at_suggestions', (payload) => {
            const data = payload as { suggestions: Array<Record<string, string>> };
            const mapped: AtSuggestion[] = (data.suggestions || []).map(s => ({
                type: s.type || 'file',
                label: s.label || s.display || '',
                detail: s.detail || '',
                path: s.path || s.id?.split(':').slice(1).join(':') || '',
            }));
            setSuggestions(mapped);
            setSelectedIndex(0);
            setLoading(false);
        });

        return () => unsub();
    }, [visible, inputValue, cursorPosition, getAtQuery]);

    // Keyboard navigation
    useEffect(() => {
        if (!visible) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    setSelectedIndex(i => Math.min(i + 1, suggestions.length - 1));
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    setSelectedIndex(i => Math.max(i - 1, 0));
                    break;
                case 'Enter':
                case 'Tab':
                    e.preventDefault();
                    if (suggestions[selectedIndex]) {
                        onSelect(suggestions[selectedIndex]);
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    onClose();
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [visible, suggestions, selectedIndex, onSelect, onClose]);

    // Click outside to close
    useEffect(() => {
        if (!visible) return;
        const handleClick = (e: MouseEvent) => {
            if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [visible, onClose]);

    if (!visible || suggestions.length === 0) return null;

    const typeIcons: Record<string, string> = {
        file: '📄', folder: '📁', symbol: '🔤', git: '🔀',
        codebase: '🔍', docs: '📚', web: '🌐', terminal: '💻',
    };

    const style: React.CSSProperties = {
        position: 'absolute',
        bottom: anchorRect ? `calc(100% - ${anchorRect.top}px + 4px)` : '100%',
        left: anchorRect ? `${anchorRect.left}px` : '16px',
        zIndex: 1000,
        maxHeight: '320px',
        minWidth: '320px',
        maxWidth: '480px',
        overflowY: 'auto',
        background: 'var(--at-popup-bg, var(--vscode-input-background, #1e1e2e))',
        border: '1px solid var(--at-popup-border, var(--vscode-editorWidget-border, #444))',
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        padding: '4px 0',
    };

    return (
        <div ref={popupRef} style={style} className="at-popup">
            {loading && <div style={{ padding: '8px 12px', opacity: 0.5, fontSize: '12px' }}>搜索中...</div>}
            {suggestions.map((s, i) => (
                <div
                    key={`${s.type}-${s.label}-${i}`}
                    className={`at-popup-item ${i === selectedIndex ? 'at-popup-item--selected' : ''}`}
                    style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        background: i === selectedIndex
                            ? 'var(--at-popup-hover, var(--vscode-list-hoverBackground, #2a2a3a))'
                            : 'transparent',
                        borderRadius: '4px',
                        margin: '0 4px',
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => onSelect(s)}
                >
                    <span style={{ fontSize: '14px', flexShrink: 0 }}>
                        {typeIcons[s.type] || '📎'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                            fontSize: '13px',
                            fontWeight: 500,
                            color: 'var(--at-popup-text, var(--vscode-foreground, #cdd6f4))',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}>
                            {s.label}
                        </div>
                        {s.detail && (
                            <div style={{
                                fontSize: '11px',
                                color: 'var(--at-popup-detail, var(--vscode-descriptionForeground, #888))',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}>
                                {s.detail}
                            </div>
                        )}
                    </div>
                    <span style={{
                        fontSize: '11px',
                        padding: '1px 6px',
                        borderRadius: '3px',
                        background: 'var(--at-popup-badge, rgba(255,255,255,0.08))',
                        color: 'var(--at-popup-badge-text, #888)',
                        flexShrink: 0,
                    }}>
                        {s.type}
                    </span>
                </div>
            ))}
        </div>
    );
}