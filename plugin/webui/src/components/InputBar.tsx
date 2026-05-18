import { useCallback, useEffect, useRef, useState } from 'react';
import { onPluginEvent, sendToPlugin } from '../bridge';
import { AtReferencePopup } from './AtReferencePopup';
import { ContextChipData } from './ContextChip';
import { ImageAttachment, ImageData } from './ImageAttachment';
import { chipFromResult, ContextRefResult, ContextRefResultCard } from './context/ContextRefResultCard';
import { ActiveRulesPill } from './rules/ActiveRulesPill';
import { builtinCommands, customCommands, CustomSlashSpec, SlashCommand } from './slash/commands';
import { SlashPopup } from './slash/SlashPopup';

interface AtSuggestion {
    type: string;
    label: string;
    detail: string;
    path?: string;
}

interface InputBarProps {
    onSend: (text: string, chips: ContextChipData[], images?: ImageData[]) => void;
    onStop: () => void;
    contextChips: ContextChipData[];
    onRemoveChip: (id: string) => void;
    onPinContext?: (chip: ContextChipData) => void;
    onModelSelect?: (id: string) => void;
    sessionCost?: { estimatedCostUsd: number; messageCount: number };
    /** Pending @ refs token estimate (from context.estimate). */
    pendingContextTokens?: number;
    /** Model context window size for budget %. */
    contextBudgetTotal?: number;
}

const CHIP_DATA_ATTR = 'data-chip-id';

/**
 * Input bar with contentEditable div that supports inline chips and @-references.
 * Chips are inserted at cursor position as non-editable spans,
 * so text and chips are naturally interleaved.
 * Typing '@' triggers the AtReferencePopup for file/symbol/codebase references.
 */
export function InputBar({ onSend, onStop, contextChips, onRemoveChip, onPinContext, onModelSelect, sessionCost, pendingContextTokens = 0, contextBudgetTotal = 128000 }: InputBarProps) {
    const [running, setRunning] = useState(false);
    const editorRef = useRef<HTMLDivElement>(null);
    const chipsMapRef = useRef<Map<string, ContextChipData>>(new Map());
    // ★ Image attachment state
    const [attachedImages, setAttachedImages] = useState<ImageData[]>([]);
    const [dragOver, setDragOver] = useState(false);
    const [recording, setRecording] = useState(false);

    // @-reference popup state
    const [atPopupVisible, setAtPopupVisible] = useState(false);
    const [_atQuery, setAtQuery] = useState('');
    const [atAnchorRect, setAtAnchorRect] = useState<DOMRect | undefined>();
    const [slashVisible, setSlashVisible] = useState(false);
    const [slashQuery, setSlashQuery] = useState('');
    const [slashAnchorRect, setSlashAnchorRect] = useState<DOMRect | undefined>();
    const [customSlash, setCustomSlash] = useState<CustomSlashSpec[]>([]);
    const [codebaseHits, setCodebaseHits] = useState<ContextRefResult[]>([]);

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
        const offDone = onPluginEvent('done', () => setRunning(false));
        const offVoice = onPluginEvent('voice_result', (payload) => appendTextToEditor((payload as { transcript?: string }).transcript ?? ''));
        const offVoiceV2 = onPluginEvent('voice.result', (payload) => appendTextToEditor((payload as { text?: string }).text ?? ''));
        const offSlash = onPluginEvent('slash.commands.loaded', (payload) => setCustomSlash(((payload as { commands?: CustomSlashSpec[] }).commands ?? [])));
        const setInput = (event: Event) => setEditorText((event as CustomEvent<string>).detail ?? '');
        document.addEventListener('codepilot:input.set', setInput);
        sendToPlugin('slash.commands.list', {}).catch(() => undefined);
        const offCodebase = onPluginEvent('codebase.search_response', (payload) => {
            const data = payload as { hits?: { path: string; snippet?: string; score?: number }[] };
            setCodebaseHits((data.hits ?? []).slice(0, 5).map((h, i) => ({
                id: `codebase-${i}-${h.path}`,
                type: 'codebase',
                title: h.path.split('/').pop() || h.path,
                path: h.path,
                snippet: h.snippet,
                tokenEstimate: Math.ceil((h.snippet?.length ?? 0) / 4),
            })));
        });
        return () => {
            offDone();
            offVoice();
            offVoiceV2();
            offSlash();
            offCodebase();
            document.removeEventListener('codepilot:input.set', setInput);
        };
    }, []);

    const handleSubmit = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const { text, chips } = extractContent(editor, chipsMapRef.current);
        if (!text.trim() && chips.length === 0 && attachedImages.length === 0) return;

        onSend(text, chips, attachedImages);
        // Clear editor and images
        editor.innerHTML = '';
        setAttachedImages([]);
        setAtPopupVisible(false);
        setRunning(true);
    }, [onSend, attachedImages]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // If @-popup is visible, let it handle navigation keys
        if ((atPopupVisible || slashVisible) && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
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

    const addImagesFromFiles = useCallback(async (files: File[]) => {
        const images: ImageData[] = [];
        for (const file of files) {
            if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) continue;
            const dataUrl = await fileToDataUrl(file);
            images.push({
                id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: file.name || 'pasted.png',
                mimeType: file.type,
                base64: dataUrl.split(',')[1] ?? '',
                thumbnail: dataUrl,
            });
        }
        if (images.length > 0) setAttachedImages((prev) => [...prev, ...images]);
    }, []);

    const addChipToEditor = useCallback((chip: ContextChipData) => {
        const editor = editorRef.current;
        if (!editor) return;
        chipsMapRef.current.set(chip.id, chip);
        insertNodeAtCursor(editor, createChipElement(chip));
        sendToPlugin('at_resolve', { id: `${chip.type}:${chip.filePath}`, chipId: chip.id }).catch(() => undefined);
    }, []);

    const handlePaste = useCallback((e: React.ClipboardEvent) => {
        const images = Array.from(e.clipboardData.items)
            .filter((item) => item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter(Boolean) as File[];
        if (images.length === 0) return;
        e.preventDefault();
        addImagesFromFiles(images);
    }, [addImagesFromFiles]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const images: File[] = [];
        for (const item of Array.from(e.dataTransfer.items)) {
            if (item.kind !== 'file') continue;
            const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean; fullPath?: string; name?: string } }).webkitGetAsEntry?.();
            const file = item.getAsFile();
            if (file?.type.startsWith('image/')) {
                images.push(file);
                continue;
            }
            const isFolder = Boolean(entry?.isDirectory);
            const name = entry?.name || file?.name || 'dropped';
            const filePath = entry?.fullPath || (file as File & { path?: string } | null)?.path || file?.webkitRelativePath || name;
            addChipToEditor({
                id: `drop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                type: isFolder ? 'folder' : 'file',
                display: name,
                filePath,
                language: '',
                startLine: null,
                endLine: null,
            });
        }
        if (images.length > 0) addImagesFromFiles(images);
    }, [addChipToEditor, addImagesFromFiles]);

    const startVoice = () => {
        setRecording(true);
        sendToPlugin('voice.start', {}).catch(() => undefined);
    };

    const stopVoice = () => {
        setRecording(false);
        sendToPlugin('voice.stop', {}).catch(() => undefined);
    };

    const hasContent = (editorRef.current?.textContent?.trim()?.length ?? 0) > 0 || contextChips.length > 0 || attachedImages.length > 0;

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

        const lineStart = text.lastIndexOf('\n', cursorOffset - 1) + 1;
        const lineFromStart = text.substring(lineStart, cursorOffset);
        const slashMatch = /^\/([\w-]*)$/.exec(lineFromStart);
        if (slashMatch) {
            setSlashQuery(slashMatch[1]);
            setSlashAnchorRect(range.getBoundingClientRect());
            setSlashVisible(true);
            setAtPopupVisible(false);
            return;
        }
        setSlashVisible(false);

        // Look backwards from cursor for '@' that isn't part of a chip
        let atIndex = -1;
        for (let i = cursorOffset - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === '@') {
                atIndex = i;
                break;
            }
            // Stop on whitespace or punctuation, including Chinese punctuation.
            if (/[\s，。！？；：、（）【】《》“”‘’]/.test(ch)) break;
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
                    // Replace @query with empty text
                    const before = text.substring(0, atIndex);
                    const after = text.substring(cursorOffset);
                    node.textContent = before + after;
                    // Position cursor at the @ position
                    const newRange = document.createRange();
                    newRange.setStart(node, atIndex);
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                }
            }
        }

        // Create an inline chip immediately in the editor
        // For types that need additional input (web, codebase), show inline input prompt
        const needsInput = ['web', 'codebase'].includes(suggestion.type) && !suggestion.path && !suggestion.label.replace(/^@\w+\s*/, '');
        const resolveValue = suggestion.path || suggestion.label.replace(/^@\w+\s*/, '');
        const display = suggestion.label.replace(/^@\w+\s*/, '') || resolveValue;

        if (needsInput) {
            // Insert @type text for the user to complete (e.g., @web https://...)
            // But keep the popup open for further typing
            setAtPopupVisible(false);
            return;
        }

        // For @web and @codebase with a value, create the chip directly
        const chipId = `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chipData: ContextChipData = {
            id: chipId,
            type: suggestion.type as ContextChipData['type'],
            display: display,
            filePath: resolveValue,
            language: '',
            startLine: null,
            endLine: null,
        };
        chipsMapRef.current.set(chipId, chipData);

        // Insert chip element at cursor
        const chipEl = createChipElement(chipData);
        insertNodeAtCursor(editor, chipEl);

        // Send at_resolve to plugin to get the full reference content
        // The plugin will store content in contextStore and return at_resolved
        sendToPlugin('at_resolve', {
            id: `${suggestion.type}:${resolveValue}`,
            chipId: chipId,
        }).catch(() => { });

        setAtPopupVisible(false);
    }, []);

    const handleAtClose = useCallback(() => {
        setAtPopupVisible(false);
    }, []);

    const allSlashCommands = [...builtinCommands(), ...customCommands(customSlash)];
    const handleSlashSelect = useCallback((cmd: SlashCommand) => {
        const editor = editorRef.current;
        const raw = editor?.textContent ?? '';
        const [head, ...rest] = raw.trim().split(/\s+/);
        const args = head?.startsWith('/') ? rest : [];
        cmd.run(args, {
            setInput: setEditorText,
            setModel: onModelSelect,
            sessionCost,
        });
        setSlashVisible(false);
        if (editor) editor.innerHTML = '';
    }, [onModelSelect, sessionCost]);

    return (
        <div className={`input-bar ${dragOver ? 'drag-over' : ''}`}>
            <div className="input-bar-meta">
                <ActiveRulesPill />
                {contextChips.length > 0 && pendingContextTokens > 0 && (
                    <span
                        className="input-context-estimate"
                        title="Estimated tokens from pending @ references (next send)"
                    >
                        +{pendingContextTokens.toLocaleString()} ctx
                        {contextBudgetTotal > 0 && (
                            <span className="input-context-pct">
                                {' '}({Math.min(100, Math.round((pendingContextTokens / contextBudgetTotal) * 100))}% budget)
                            </span>
                        )}
                    </span>
                )}
            </div>
            {codebaseHits.length > 0 && (
                <div className="codebase-hits-inline">
                    {codebaseHits.map((h) => (
                        <ContextRefResultCard
                            key={h.id}
                            result={h}
                            onPin={(r) => onPinContext?.(chipFromResult(r))}
                            onUnpin={() => setCodebaseHits((prev) => prev.filter((x) => x.id !== h.id))}
                        />
                    ))}
                </div>
            )}
            {dragOver && <div className="drag-overlay">松开以引用文件/文件夹或添加图片</div>}
            <div
                ref={editorRef}
                className="input-editor"
                contentEditable
                suppressContentEditableWarning
                onKeyDown={handleKeyDown}
                onClick={handleEditorClick}
                onInput={handleEditorInput}
                onPaste={handlePaste}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
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
            {slashVisible && (
                <SlashPopup
                    query={slashQuery}
                    commands={allSlashCommands}
                    anchorRect={slashAnchorRect}
                    onSelect={handleSlashSelect}
                    onClose={() => setSlashVisible(false)}
                />
            )}
            {/* ★ Attached image thumbnails preview */}
            {attachedImages.length > 0 && (
                <div className="attached-images-preview" style={{ display: 'flex', gap: '4px', padding: '4px 8px', flexWrap: 'wrap' }}>
                    {attachedImages.map(img => (
                        <div key={img.id} style={{ position: 'relative', width: '48px', height: '48px' }}>
                            <img src={img.thumbnail} alt={img.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} />
                            <button
                                onClick={() => setAttachedImages(prev => prev.filter(i => i.id !== img.id))}
                                style={{ position: 'absolute', top: '-4px', right: '-4px', background: '#ef5350', border: 'none', borderRadius: '50%', width: '14px', height: '14px', color: '#fff', fontSize: '9px', cursor: 'pointer', lineHeight: '14px', padding: 0 }}
                            >×</button>
                        </div>
                    ))}
                </div>
            )}
            <div className="input-send-area">
                <ImageAttachment onAttach={(imgs) => setAttachedImages(prev => [...prev, ...imgs])} />
                <button
                    type="button"
                    className={`voice-btn ${recording ? 'recording' : ''}`}
                    onMouseDown={startVoice}
                    onMouseUp={stopVoice}
                    onMouseLeave={() => recording && stopVoice()}
                    title="按住说话"
                >
                    {recording ? 'Rec' : 'Voice'}
                </button>
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

function appendTextToEditor(text: string) {
    if (!text.trim()) return;
    const editor = document.querySelector('.input-editor') as HTMLDivElement | null;
    if (!editor) return;
    editor.focus();
    insertNodeAtCursor(editor, document.createTextNode(text));
}

function setEditorText(text: string) {
    const editor = document.querySelector('.input-editor') as HTMLDivElement | null;
    if (!editor) return;
    editor.textContent = text;
    editor.focus();
}

function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
    });
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
    folder: '📁',
    symbol: '🔤',
    git: '🔀',
    codebase: '🔍',
    docs: '📚',
    web: '🌐',
    terminal: '💻',
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