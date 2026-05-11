import { useRef, useState } from 'react';

interface ImageAttachmentProps {
    onAttach: (images: ImageData[]) => void;
}

export interface ImageData {
    id: string;
    name: string;
    mimeType: string;
    base64: string;
    thumbnail: string; // Small preview URL
}

/**
 * Image attachment component for multi-modal input.
 * Supports:
 * - Drag & drop images onto the input area
 * - Paste images from clipboard (Ctrl+V)
 * - Click to browse file picker
 *
 * Images are stored as base64 and sent with the conversation request.
 * Backend PromptOrchestrator checks model vision capability before injecting.
 */
export function ImageAttachment({ onAttach }: ImageAttachmentProps) {
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const processFiles = async (files: FileList | File[]) => {
        const images: ImageData[] = [];
        const fileArray = Array.from(files);

        for (const file of fileArray) {
            if (!file.type.startsWith('image/')) continue;
            if (file.size > 10 * 1024 * 1024) continue; // Max 10MB

            const base64 = await fileToBase64(file);
            const thumbnail = await createThumbnail(file);
            images.push({
                id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: file.name,
                mimeType: file.type,
                base64,
                thumbnail,
            });
        }

        if (images.length > 0) {
            onAttach(images);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length > 0) {
            processFiles(e.dataTransfer.files);
        }
    };

    const handlePaste = (e: React.ClipboardEvent) => {
        const items = Array.from(e.clipboardData.items);
        const imageItems = items.filter(item => item.type.startsWith('image/'));
        if (imageItems.length === 0) return;

        e.preventDefault();
        const files = imageItems.map(item => item.getAsFile()).filter(Boolean) as File[];
        processFiles(files);
    };

    const handleClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            processFiles(e.target.files);
            e.target.value = ''; // Reset
        }
    };

    return (
        <>
            <button
                onClick={handleClick}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                title="添加图片 (拖拽/粘贴/点击)"
                style={{
                    background: dragging ? 'var(--accent-bg, #58a6ff22)' : 'none',
                    border: dragging ? '2px dashed var(--accent, #58a6ff)' : '1px solid transparent',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: '16px',
                    color: '#888',
                    transition: 'all 0.15s',
                }}
            >
                🖼️
            </button>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileChange}
            />
        </>
    );
}

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1]); // Remove data:image/...;base64, prefix
        };
        reader.readAsDataURL(file);
    });
}

function createThumbnail(file: File): Promise<string> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        resolve(url); // Use object URL as thumbnail
    });
}