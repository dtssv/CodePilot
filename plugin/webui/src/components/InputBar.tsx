import { useCallback, useEffect, useRef, useState } from 'react';
import { onPluginEvent } from '../bridge';
import { ContextChipData } from './ContextChip';

interface InputBarProps {
    onSend: (text: string, chips: ContextChipData[]) => void;
    onStop: () => void;
    contextChips: ContextChipData[];
    onRemoveChip: (id: string) => void;
}

const CHIP_DATA_ATTR = 'data-chip-id';

/**
 * Input bar with contentEditable div that supports inline chips.
 * Chips are inserted at cursor position as non-editable spans,
 * so text and chips are naturally interleaved.
 */
export function InputBar({ onSend, onStop, contextChips, onRemoveChip }: InputBarProps) {
    const [running, setRunning] = useState(false);
    const editorRef = useRef<HTMLDivElement>(null);
    const chipsMapRef = useRef<Map<string, ContextChipData>>(new Map());

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
        setRunning(true);
    }, [onSend]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
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

    return (
        <div className="input-bar">
            <div
                ref={editorRef}
                className="input-editor"
                contentEditable
                suppressContentEditableWarning
                onKeyDown={handleKeyDown}
                onClick={handleEditorClick}
                data-placeholder={contextChips.length > 0 ? "Add a message about this context..." : "Ask CodePilot... (Enter to send, Shift+Enter for newline)"}
            />
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