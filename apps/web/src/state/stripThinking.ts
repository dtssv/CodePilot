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

  const out: ThinkingSegment[] = [];
  let last = 0;
  const re = new RegExp(THINK_BLOCK.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const before = scrubOrphanTags(text.slice(last, m.index));
      if (before.trim()) out.push({ kind: "text", text: before });
    }
    const body = (m[1] ?? "").replace(/^\n+|\n+$/g, "");
    if (body.trim()) out.push({ kind: "think", text: body });
    last = m.index + m[0].length;
  }

  const rest = text.slice(last);
  const openIdx = rest.search(THINK_OPEN);
  if (openIdx >= 0) {
    const before = scrubOrphanTags(rest.slice(0, openIdx));
    if (before.trim()) out.push({ kind: "text", text: before });
    const openMatch = rest.slice(openIdx).match(THINK_OPEN)!;
    const body = rest.slice(openIdx + openMatch[0].length);
    out.push({ kind: "think", text: body, incomplete: true });
  } else {
    const cleaned = scrubOrphanTags(rest);
    if (cleaned.trim()) out.push({ kind: "text", text: cleaned });
  }

  return out;
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
