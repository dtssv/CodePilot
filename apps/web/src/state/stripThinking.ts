// Browser copy of packages/core/src/stripThinking.ts — the web bundle cannot
// import the core barrel (it pulls Node built-ins). Keep in sync.

const TAG_NAMES = "think|thinking|redacted_reasoning";
const THINK_BLOCK = new RegExp(
  `<(?:${TAG_NAMES})\\b[^>]*>([\\s\\S]*?)<\\/(?:${TAG_NAMES})\\s*>`,
  "gi",
);
const THINK_OPEN = new RegExp(`<(?:${TAG_NAMES})\\b[^>]*>`, "i");
const THINK_TAG = new RegExp(`<\\/?(?:${TAG_NAMES})\\b[^>]*>`, "gi");

export type ThinkingSegment =
  | { kind: "text"; text: string }
  | { kind: "think"; text: string; incomplete?: boolean };

function scrubOrphanTags(s: string): string {
  return s
    .replace(THINK_TAG, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function splitThinking(text: string): ThinkingSegment[] {
  if (!text) return [];
  if (!new RegExp(`<\\/?(?:${TAG_NAMES})\\b`, "i").test(text)) {
    return [{ kind: "text", text }];
  }
  // Literal `<think>`-style tags inside Markdown code (fenced ``` or inline
  // `...`) are content, not a model reasoning stream. Detect on a code-masked
  // copy but slice the original text so bodies keep their exact content.
  const masked = maskCodeSpans(text);
  if (!new RegExp(`<\\/?(?:${TAG_NAMES})\\b`, "i").test(masked)) {
    return [{ kind: "text", text }];
  }
  return splitThinkingRaw(text, masked);
}

function splitThinkingRaw(text: string, matchOn: string): ThinkingSegment[] {
  const out: ThinkingSegment[] = [];
  let last = 0;
  const re = new RegExp(THINK_BLOCK.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(matchOn)) !== null) {
    if (m.index > last) {
      const before = scrubOrphanTags(text.slice(last, m.index));
      if (before.trim()) out.push({ kind: "text", text: before });
    }
    const openLen = matchOn.slice(m.index).match(THINK_OPEN)?.[0].length ?? 0;
    const bodyStart = m.index + openLen;
    const bodyEnd = m.index + m[0].length - closeTagLen(matchOn, m.index + m[0].length);
    const body = text.slice(bodyStart, bodyEnd).replace(/^\n+|\n+$/g, "");
    if (body.trim()) out.push({ kind: "think", text: body });
    last = m.index + m[0].length;
  }

  const rest = text.slice(last);
  const restMask = matchOn.slice(last);
  const openIdx = restMask.search(THINK_OPEN);
  if (openIdx >= 0) {
    const before = scrubOrphanTags(rest.slice(0, openIdx));
    if (before.trim()) out.push({ kind: "text", text: before });
    const openMatch = restMask.slice(openIdx).match(THINK_OPEN)!;
    const body = rest.slice(openIdx + openMatch[0].length);
    out.push({ kind: "think", text: body, incomplete: true });
  } else {
    const cleaned = scrubOrphanTags(rest);
    if (cleaned.trim()) out.push({ kind: "text", text: cleaned });
  }

  return out;
}

function closeTagLen(s: string, end: number): number {
  const m = s.slice(0, end).match(new RegExp(`<\\/(?:${TAG_NAMES})\\s*>$`, "i"));
  return m ? m[0].length : 0;
}

/** Mask the contents of Markdown code spans (same length, keep delimiters) so
 * think-tag detection ignores literal tags shown as code. */
function maskCodeSpans(text: string): string {
  const chars = text.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  };
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2|$)/gm;
  let fm: RegExpExecArray | null;
  const fencedRanges: Array<[number, number]> = [];
  while ((fm = fence.exec(text)) !== null) {
    const bodyStart = fm.index + fm[0].indexOf("\n") + 1;
    const bodyEnd = fm.index + fm[0].length;
    blank(bodyStart, bodyEnd);
    fencedRanges.push([fm.index, bodyEnd]);
  }
  const inFenced = (i: number): boolean => fencedRanges.some(([a, b]) => i >= a && i < b);
  const inline = /(`+)(?!`)([\s\S]*?)\1(?!`)/g;
  let im: RegExpExecArray | null;
  const masked = chars.join("");
  let result = masked;
  while ((im = inline.exec(masked)) !== null) {
    if (inFenced(im.index)) continue;
    const from = im.index + im[1].length;
    const to = im.index + im[0].length - im[1].length;
    result = result.slice(0, from) + " ".repeat(to - from) + result.slice(to);
  }
  return result;
}

export function stripThinking(text: string): string {
  if (!text || !new RegExp(`<\\/?(?:${TAG_NAMES})\\b`, "i").test(text)) return text;
  return splitThinking(text)
    .filter((s): s is Extract<ThinkingSegment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the transcript should render this assistant message. */
export function hasVisibleAssistantContent(text: string): boolean {
  for (const s of splitThinking(text)) {
    if (s.kind === "think") {
      if (s.incomplete || s.text.trim() !== "") return true;
    } else if (s.text.trim() !== "") {
      return true;
    }
  }
  return false;
}
