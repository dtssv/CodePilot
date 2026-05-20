/**
 * Shared markdown normalization for LLM prose (frontend). Keep in sync with
 * GraphContentSanitizer.normalizeMarkdown on the backend.
 */

/** Improve markdown structure so GFM parsers render headings/lists/tables reliably. */
export function normalizeMarkdownForDisplay(text: string): string {
    if (!text) return '';
    let s = text.replace(/\r\n/g, '\n');

    // HTML line breaks → newline
    s = s.replace(/<br\s*\/?>/gi, '\n');

    // "# # 1. item" / "## 1. item" → ordered list line (not ATX headings)
    s = s.replace(/^(?:#\s+)+(?=\d+\.\s)/gm, '');
    s = s.replace(/^#{1,6}\s+(\d+\.\s+.+)$/gm, '$1');

    // Headings glued after CJK punctuation: "用户。##分析" (never break "1. # …" lists)
    s = s.replace(/([。！？!?])\s*(#{1,6})(\S)/gu, '$1\n\n$2 $3');
    s = s.replace(/(?<!\d)\.(\s*)(#{1,6})(\S)/g, '.\n\n$1$2 $3');
    s = s.replace(/^(#{1,6})([^\s#].*)$/gm, '$1 $2');

    // Spaced extensions: "设计文档. md" → "设计文档.md"
    s = s.replace(/([\w\u4e00-\u9fff-]+)\s+\.\s*(md|txt|cpp|hpp|h|cc|c|java|kt|json|yaml|yml|xml|gradle|cmake)\b/gi, '$1.$2');

    // Lists need a blank line before them
    s = s.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2');
    s = s.replace(/([^\n])\n(\s*[-*+]\s)/g, '$1\n\n$2');
    s = s.replace(/([^\n])\n(\s*\d+\.\s)/g, '$1\n\n$2');

    // "1.item" or "-item" glued to previous line
    s = s.replace(/^(\d+)\.(\S)/gm, '$1. $2');
    s = s.replace(/([^\n])\s+([-*+])\s+(?=\S)/g, '$1\n\n$2 ');

    // Orphan list markers after CJK period
    s = s.replace(/([。！？])\s*>\s*(?=[\u4e00-\u9fffA-Za-z])/g, '$1\n\n');

    // Glued Chinese step labels: "。 -第五步：" → newline before "第五步："
    s = s.replace(
        /([。！？；;）)])\s*[-–—]?\s*(第[一二三四五六七八九十百千万0-9]+步\s*[：:])/g,
        '$1\n\n$2',
    );
    s = s.replace(
        /(?<=[\u4e00-\u9fff）)])\s*[-–—]\s*(第[一二三四五六七八九十百千万0-9]+步\s*[：:])/g,
        '\n\n$1',
    );

    s = fixRepeatedOrderedListOnes(s);

    // Broken emphasis at EOL
    s = s.replace(/\*{3,}/g, '**');
    s = s.replace(/(^|[^*])\*(\s*)$/gm, '$1');

    // Fence: ensure newline after opening ```
    s = s.replace(/```(\w*)([^\n`])/g, '```$1\n$2');

    // Table rows: ensure pipe table has header separator when missing (minimal fix)
    s = s.replace(
        /^(\|.+\|)\n(?!\|[-:\s|]+\|)(\|.+\|)$/gm,
        '$1\n| --- |\n$2',
    );

    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

/** Renumber consecutive `1.` lines so GFM ordered lists display 1, 2, 3… */
function fixRepeatedOrderedListOnes(text: string): string {
    const lines = text.split('\n');
    const out: string[] = [];
    const listRe = /^(\s*)(\d+)\.\s+(.+)$/;
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (!m) {
            out.push(lines[i]);
            i++;
            continue;
        }
        const blockStart = i;
        let blockEnd = i;
        const items: { indent: string; body: string }[] = [];
        let allOnes = true;
        while (blockEnd < lines.length) {
            const line = lines[blockEnd];
            if (!line.trim()) {
                if (blockEnd + 1 < lines.length && listRe.test(lines[blockEnd + 1])) {
                    blockEnd++;
                    continue;
                }
                break;
            }
            const lm = line.match(listRe);
            if (!lm) break;
            if (lm[2] !== '1') allOnes = false;
            items.push({ indent: lm[1], body: lm[3] });
            blockEnd++;
        }
        if (allOnes && items.length >= 2) {
            items.forEach((item, idx) => {
                out.push(`${item.indent}${idx + 1}. ${item.body}`);
            });
        } else {
            for (let j = blockStart; j < blockEnd; j++) out.push(lines[j]);
        }
        i = blockEnd;
    }
    return out.join('\n');
}
