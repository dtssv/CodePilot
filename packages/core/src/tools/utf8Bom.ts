/** UTF-8 BOM (`U+FEFF`). Node's `readFile(..., "utf-8")` surfaces it as this
 * character at index 0; writing the same string back emits `EF BB BF`. */

export const UTF8_BOM = "\uFEFF";

/** Strip a leading UTF-8 BOM if present. Edits/searches should run on the
 * stripped body so model-copied snippets (from `read_file` without BOM) match. */
export function stripUtf8Bom(text: string): { text: string; hadBom: boolean } {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return { text: text.slice(1), hadBom: true };
  }
  return { text, hadBom: false };
}

/** Re-attach a BOM when the on-disk file originally had one (or the caller
 * already included it). Idempotent if `text` already starts with BOM. */
export function restoreUtf8Bom(text: string, hadBom: boolean): string {
  if (!hadBom) return text;
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) return text;
  return UTF8_BOM + text;
}
