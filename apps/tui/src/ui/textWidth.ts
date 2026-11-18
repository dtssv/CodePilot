/**
 * Terminal cell width helpers. The live region and the detail viewer must stay
 * shorter than the terminal (Ink clears and reprints everything otherwise), so
 * line counts are computed here instead of guessed.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x09) return 4;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** Hard-wrap one logical line into rows of at most `width` cells. */
export function wrapLine(line: string, width: number): string[] {
  const max = Math.max(1, width);
  const clean = stripAnsi(line).replace(/\t/g, "    ");
  if (clean === "") return [""];
  const out: string[] = [];
  let cur = "";
  let w = 0;
  for (const ch of clean) {
    const cw = charWidth(ch);
    if (w + cw > max) {
      out.push(cur);
      cur = "";
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  out.push(cur);
  return out;
}

/** Rows `text` occupies when rendered `width` cells wide. */
export function wrappedHeight(text: string, width: number): number {
  let n = 0;
  for (const line of text.split("\n")) n += Math.max(1, Math.ceil(textWidth(line) / Math.max(1, width)));
  return n;
}

/** Cut `s` to at most `width` cells, ending with "…" when shortened. */
export function truncateToWidth(s: string, width: number): string {
  const clean = stripAnsi(s);
  if (textWidth(clean) <= width) return clean;
  let out = "";
  let w = 0;
  for (const ch of clean) {
    const cw = charWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}
