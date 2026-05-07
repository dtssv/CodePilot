/**
 * Context reference data — compact display only.
 * Full code is stored in the Kotlin-side contextStore, not in the WebUI.
 */

export interface ContextChipData {
    id: string;             // context ID (maps to fullCode in Kotlin contextStore)
    type: 'code' | 'file' | 'package';
    display: string;        // compact label shown in the chip
    filePath: string;
    language: string;
    startLine: number | null;
    endLine: number | null;
}

let nextChipId = 1;
export function makeChipId(): string {
    return `ctx-${nextChipId++}`;
}