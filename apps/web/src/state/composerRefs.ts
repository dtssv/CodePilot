// Structured composer references (file / selection). Shown as chips; serialized
// to `@path` / `@path:Lstart-end` on send so all surfaces share one wire form.

export type ComposerRef = {
  id: string;
  /** Workspace-relative path. */
  path: string;
  /** Optional 1-based line range (selection). */
  startLine?: number;
  endLine?: number;
};

export function composerRefId(ref: Omit<ComposerRef, "id">): string {
  if (ref.startLine != null && ref.endLine != null) {
    return `${ref.path}:${ref.startLine}-${ref.endLine}`;
  }
  return ref.path;
}

export function formatComposerRef(ref: ComposerRef): string {
  if (ref.startLine != null && ref.endLine != null) {
    return `@${ref.path}:L${ref.startLine}-${ref.endLine}`;
  }
  return `@${ref.path}`;
}

export function composerRefLabel(ref: ComposerRef): string {
  const base = ref.path.split(/[/\\]/).pop() || ref.path;
  if (ref.startLine != null && ref.endLine != null) {
    return `${base}:${ref.startLine}-${ref.endLine}`;
  }
  return base;
}

/** Prepend chip refs to free-text for the model. */
export function mergeRefsIntoPrompt(text: string, refs: ComposerRef[]): string {
  if (refs.length === 0) return text;
  const head = refs.map(formatComposerRef).join(" ");
  const body = text.trim();
  return body ? `${head}\n\n${body}` : head;
}

/**
 * Match an `@mention` token at/near the caret. Mentions run until whitespace.
 * Used so Backspace/Delete removes the whole `@path` (or `@path:L1-2`) token.
 */
export function findMentionAtCaret(
  text: string,
  caret: number,
  mode: "backspace" | "delete",
): { start: number; end: number } | null {
  if (mode === "backspace") {
    if (caret <= 0) return null;
    // If caret is right after a mention, or inside one, delete that mention.
    const before = text.slice(0, caret);
    const m = /(?:^|[\s])(@[^\s]*)$/.exec(before);
    if (!m || m.index === undefined) return null;
    const at = m[1]!;
    if (at.length < 2) return null; // bare "@"
    const start = m.index + (m[0].startsWith("@") ? 0 : 1);
    return { start, end: caret };
  }
  // Delete key: remove mention starting at caret (or caret inside mention).
  if (caret >= text.length) return null;
  // Walk left to @ if we're mid-token.
  let i = caret;
  while (i > 0 && !/\s/.test(text[i - 1]!) && text[i - 1] !== "@") i--;
  if (i > 0 && text[i - 1] === "@") i--;
  else if (text[i] !== "@") {
    // Maybe caret is on @
    if (text[caret] === "@") i = caret;
    else return null;
  }
  if (text[i] !== "@") return null;
  let end = i + 1;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  if (end - i < 2) return null;
  // Only claim if caret is inside [i, end]
  if (caret < i || caret > end) return null;
  return { start: i, end };
}

export function newComposerRef(partial: Omit<ComposerRef, "id">): ComposerRef {
  return { ...partial, id: composerRefId(partial) };
}
