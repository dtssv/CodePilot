export interface EditorFile {
  path: string;
  content: string;
  size: number;
  hash: string;
  truncated: boolean;
  original?: string;
  originalHash?: string;
}

export function acceptSave(file: EditorFile, result: { size: number; hash: string }): EditorFile {
  return { ...file, size: result.size, hash: result.hash, originalHash: result.hash, original: file.content };
}

export function changedExternally(file: EditorFile, stat: { exists: boolean; hash: string }): boolean {
  return !stat.exists || stat.hash !== (file.originalHash ?? file.hash);
}

export function canSave(file: EditorFile, saving: boolean, conflict: boolean): boolean {
  return !saving && !conflict && !file.truncated && file.content !== file.original;
}
