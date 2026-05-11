import { useCallback, useEffect, useRef, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
import { AtReferencePopup } from './AtReferencePopup';
import { ContextChipData } from './ContextChip';

interface AtSuggestion {
    type: string;
    label: string;
    detail: string;
    path?: string;
}

interface InputBarProps {
    onSend: (text: string, chips: ContextChipData[]) => void;
    onStop: () => void;
    contextChips: ContextChipData[];
    onRemoveChip: (id: string) => void;
}

const CHIP_DATA_ATTR = 'data-chip-id';

/**
 * Input bar with contentEditable div that supports inline chips and @-references.
 * Chips are inserted at cursor position as non-editable spans,
 * so text and chips are naturally interleaved.
 * Typing '@' triggers the AtReferencePopup for file/symbol/codebase references.
 */
export function InputBar({ onSend, onStop, contextChips, onRemoveChip }: InputBarProps) {
    const [running, setRunning] = useState(false);
    const editorRef = useRef<HTMLDivElement>(null);
    const chipsMapRef = useRef<Map<string, ContextChipData>>(new Map());

    // @-reference popup state
    const [atPopupVisible, setAtPopupVisible] = useState(false);
    const [_atQuery, setAtQuery] = useState('');
    const [atAnchorRect, setAtAnchorRect] = useState<DOMRect | undefined>();

    // Keep chipsMapRef in sync
    useEffect(() => {
        chipsMapRef.current = new Map(contextChips.map(c => [c.id, c]));
    }, [contextChips]);

    // When a new chip is added, insert it at cursor position in the editor
    useEffect(() => {
        if (contextChips.length === 0) return;
        const editor = editorRef.current;
        if (!editor) return;

        // Find chips that aren't yet in the DOM
        const existingIds = new Set(
            Array.from(editor.querySelectorAll(`[${CHIP_DATA_ATTR}]`))
                .map(el => el.getAttribute(CHIP_DATA_ATTR))
        );

        const newChips = contextChips.filter(c => !existingIds.has(c.id));
        if (newChips.length === 0) return;

        for (const chip of newChips) {
            const span = createChipElement(chip);
            insertNodeAtCursor(editor, span);
        }

        editor.focus();
    }, [contextChips]);

    useEffect(() => {
        const unsub = onPluginEvent('done', () => setRunning(false));
        return unsub;
    }, []);

    const handleSubmit = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const { text, chips } = extractContent(editor, chipsMapRef.current);
        if (!text.trim() && chips.length === 0) return;

        onSend(text, chips);
        // Clear editor
        editor.innerHTML = '';
        setAtPopupVisible(false);
        setRunning(true);
    }, [onSend]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // If @-popup is visible, let it handle navigation keys
        if (atPopupVisible && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
            return; // AtReferencePopup handles these via its own listener
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleStop = () => {
        onStop();
        setRunning(false);
    };

    const hasContent = (editorRef.current?.textContent?.trim()?.length ?? 0) > 0 || contextChips.length > 0;

    // Handle click on remove button inside chip
    const handleEditorClick = (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        const removeBtn = target.closest('.chip-remove');
        if (removeBtn) {
            const chipSpan = removeBtn.closest(`[${CHIP_DATA_ATTR}]`);
            const chipId = chipSpan?.getAttribute(CHIP_DATA_ATTR);
            if (chipId) {
                chipSpan?.remove();
                onRemoveChip(chipId);
            }
        }
    };

    // Detect '@' character input to trigger AtReferencePopup
    const handleEditorInput = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;

        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) return;

        const text = node.textContent || '';
        const cursorOffset = range.startOffset;

        // Look backwards from cursor for '@' that isn't part of a chip
        let atIndex = -1;
        for (let i = cursorOffset - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === '@') {
                atIndex = i;
                break;
            }
            // Stop if we hit whitespace — @ must be at start or after space
            if (/\s/.test(ch)) break;
        }

        if (atIndex >= 0) {
            const query = text.substring(atIndex + 1, cursorOffset);
            setAtQuery(query);
            setAtPopupVisible(true);

            // Get anchor rect for popup positioning
            const rect = range.getBoundingClientRect();
            setAtAnchorRect(new DOMRect(rect.left, rect.bottom, rect.width, rect.height));
        } else {
            setAtPopupVisible(false);
        }
    }, []);

    // Handle @-suggestion selection: replace @query with a context chip
    const handleAtSelect = useCallback((suggestion: AtSuggestion) => {
        const editor = editorRef.current;
        if (!editor) return;

        // Remove the @query text from the editor
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const node = range.startContainer;
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                const cursorOffset = range.startOffset;
                // Find the @ position
                let atIndex = -1;
                for (let i = cursorOffset - 1; i >= 0; i--) {
                    if (text[i] === '@') { atIndex = i; break; }
                    if (/\s/.test(text[i])) break;
                }
                if (atIndex >= 0) {
                    // Replace @query with empty text (chip will be added separately)
                    const before = text.substring(0, atIndex);
                    const after = text.substring(cursorOffset);
                    node.textContent = before + after;
                    // Position cursor
                    const newRange = document.createRange();
                    newRange.setStart(node, atIndex);
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                }
            }
        }

        // Send at_resolve to plugin to get the full reference data
        sendToPlugin('at_resolve', { type: suggestion.type, value: suggestion.path || suggestion.label }).catch(() => { });

        setAtPopupVisible(false);
    }, []);

    const handleAtClose = useCallback(() => {
        setAtPopupVisible(false);
    }, []);

    return (
        <div className="input-bar">
            <div
                ref={editorRef}
                className="input-editor"
                contentEditable
                suppressContentEditableWarning
                onKeyDown={handleKeyDown}
                onClick={handleEditorClick}
                onInput={handleEditorInput}
                data-placeholder={contextChips.length > 0 ? "Add a message about this context... (type @ to reference)" : "Ask CodePilot... (type @ for references, Enter to send)"}
            />
            {atPopupVisible && (
                <AtReferencePopup
                    inputValue={editorRef.current?.textContent || ''}
                    cursorPosition={getCursorTextOffset(editorRef.current)}
                    visible={atPopupVisible}
                    onSelect={handleAtSelect}
                    onClose={handleAtClose}
                    anchorRect={atAnchorRect}
                />
            )}
            <div className="input-send-area">
                {running ? (
                    <button className="stop-btn" onClick={handleStop}>Stop</button>
                ) : (
                    <button className="send-btn" onClick={handleSubmit} disabled={!hasContent}>↑</button>
                )}
            </div>
        </div>
    );
}

/** Get the text offset of the cursor within the editor */
function getCursorTextOffset(editor: HTMLDivElement | null): number {
    if (!editor) return 0;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;

    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.setStart(editor, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
}

/** Create a chip span element for insertion into contentEditable */
function createChipElement(chip: ContextChipData): HTMLSpanElement {
    const span = document.createElement('span');
    span.setAttribute(CHIP_DATA_ATTR, chip.id);
    span.setAttribute('contenteditable', 'false');
    span.className = `context-chip chip-${chip.type} chip-inline`;
    span.setAttribute('data-display', chip.display);

    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.textContent = typeIcons[chip.type] || '📎';

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = chip.display;
    label.title = chip.filePath;

    const remove = document.createElement('span');
    remove.className = 'chip-remove';
    remove.textContent = '×';
    remove.title = 'Remove';

    span.appendChild(icon);
    span.appendChild(label);
    span.appendChild(remove);

    // Add a zero-width space after to allow cursor to move past the chip
    // (done in insertNodeAtCursor instead)

    return span;
}

const typeIcons: Record<string, string> = {
    code: '{ }',
    file: '📄',
    package: '📦',
};

/** Insert a node at the current cursor/selection position */
function insertNodeAtCursor(editor: HTMLDivElement, node: Node) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
        editor.appendChild(node);
        return;
    }

    const range = sel.getRangeAt(0);

    // If cursor is inside the editor, insert there
    if (editor.contains(range.commonAncestorContainer)) {
        range.collapse(true);
        range.insertNode(node);
        // Move cursor after the inserted node
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    } else {
        // Cursor not in editor — append at end
        editor.appendChild(node);
    }

    // Ensure the zero-width space after chip
    const after = document.createTextNode('\u200B');
    if (node.parentNode) {
        node.parentNode.insertBefore(after, node.nextSibling);
    }
}

/** Extract plain text and chip refs from the contentEditable editor */
function extractContent(editor: HTMLDivElement, chipsMap: Map<string, ContextChipData>): { text: string; chips: ContextChipData[] } {
    const chips: ContextChipData[] = [];
    const parts: string[] = [];

    function walk(node: Node) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Strip zero-width spaces
            parts.push(node.textContent?.replace(/\u200B/g, '') || '');
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            const chipId = el.getAttribute(CHIP_DATA_ATTR);
            if (chipId) {
                const chipData = chipsMap.get(chipId);
                if (chipData) {
                    chips.push(chipData);
                    // Insert inline placeholder preserving position in text
                    parts.push(`\x01${chipId}\x01`);
                }
            } else if (el.classList.contains('chip-remove') || el.classList.contains('chip-icon') || el.classList.contains('chip-label')) {
                // Skip chip internal elements
                return;
            } else {
                for (const child of Array.from(node.childNodes)) {
                    walk(child);
                }
                // Add newline for div/block elements
                if (el.tagName === 'DIV' || el.tagName === 'BR') {
                    parts.push('\n');
                }
            }
        }
    }

    for (const child of Array.from(editor.childNodes)) {
        walk(child);
    }

    return { text: parts.join(''), chips };
}