/**
 * Minimal markdown renderer for Ink.
 *
 * Handles a pragmatic subset well enough for assistant messages:
 *   - fenced code blocks ```lang … ```
 *   - inline code `…`
 *   - **bold** and *italic*
 *   - headings (# … ######)
 *   - lists (-, *, 1.)
 *   - blockquotes (> )
 *   - links [text](url)
 *
 *   The renderer is pure (no I/O, no theme).
 */
import React from "react";
import { Text, Box } from "ink";

interface InlineToken {
  kind: "text" | "code" | "bold" | "italic" | "link";
  value: string;
  href?: string;
}

function parseInline(s: string): InlineToken[] {
  const out: InlineToken[] = [];
  let i = 0;
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ kind: "text", value: buf });
      buf = "";
    }
  };
  while (i < s.length) {
    const c = s[i]!;
    // Inline code
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "code", value: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Link [text](url)
    if (c === "[" && s[i + 1] !== undefined) {
      const closeText = s.indexOf("]", i + 1);
      if (closeText > i && s[closeText + 1] === "(") {
        const closeUrl = s.indexOf(")", closeText + 2);
        if (closeUrl > closeText) {
          flush();
          out.push({
            kind: "link",
            value: s.slice(i + 1, closeText),
            href: s.slice(closeText + 2, closeUrl),
          });
          i = closeUrl + 1;
          continue;
        }
      }
    }
    // Bold (**…**)
    if (c === "*" && s[i + 1] === "*") {
      const end = s.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        out.push({ kind: "bold", value: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Italic (*…*)
    if (c === "*") {
      const end = s.indexOf("*", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "italic", value: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function renderInline(s: string, key: string): React.ReactNode {
  const tokens = parseInline(s);
  return tokens.map((t, idx) => {
    const k = `${key}-${idx}`;
    switch (t.kind) {
      case "text":
        return <Text key={k}>{t.value}</Text>;
      case "code":
        return (
          <Text key={k} color="yellow">
            {t.value}
          </Text>
        );
      case "bold":
        return (
          <Text key={k} bold>
            {parseInline(t.value).map((tt, j) => (
              <Text key={`${k}-b-${j}`} bold>
                {tt.value}
              </Text>
            ))}
          </Text>
        );
      case "italic":
        return (
          <Text key={k} italic>
            {t.value}
          </Text>
        );
      case "link":
        return (
          <Text key={k} color="cyan" underline>
            {t.value}
          </Text>
        );
    }
  });
}

interface Block {
  kind: "heading" | "paragraph" | "code" | "ul" | "ol" | "quote" | "blank";
  level?: number;
  lang?: string;
  items?: string[];
  text?: string;
}

function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ kind: "code", lang, text: buf.join("\n") });
      continue;
    }
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    // Quote
    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        buf.push(lines[i]!.slice(2));
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }
    // Unordered list
    if (/^(\s*)[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^(\s*)[-*]\s+/, ""));
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""));
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    // Blank
    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }
    // Paragraph (consume until blank)
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.trimStart().startsWith("```") &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^(\s*)[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !lines[i]!.startsWith("> ")
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: "paragraph", text: buf.join(" ") });
  }
  return blocks;
}

export interface MarkdownProps {
  children: string;
  /** Optional dimming for partial streams. */
  dimColor?: boolean;
}

export function Markdown({ children, dimColor }: MarkdownProps): React.ReactElement {
  const blocks = parseBlocks(children);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        const key = `b-${i}`;
        switch (b.kind) {
          case "heading": {
            const text = b.text ?? "";
            const color =
              b.level === 1
                ? "magenta"
                : b.level === 2
                ? "blue"
                : b.level === 3
                ? "cyan"
                : "white";
            return (
              <Box key={key} marginTop={1}>
                <Text bold color={color}>
                  {"#".repeat(b.level ?? 1)} {text}
                </Text>
              </Box>
            );
          }
          case "paragraph":
            return (
              <Text key={key} dimColor={dimColor}>
                {renderInline(b.text ?? "", key)}
              </Text>
            );
          case "code":
            return (
              <Box
                key={key}
                borderStyle="round"
                borderColor="gray"
                flexDirection="column"
                paddingX={1}
                marginY={1}
              >
                {(b.lang ?? "") !== "" ? (
                  <Text dimColor>
                    {b.lang}
                  </Text>
                ) : null}
                <Text>{b.text ?? ""}</Text>
              </Box>
            );
          case "ul":
            return (
              <Box key={key} flexDirection="column">
                {(b.items ?? []).map((it, j) => (
                  <Text key={`${key}-${j}`}>
                    {"  • "}
                    {renderInline(it, `${key}-${j}`)}
                  </Text>
                ))}
              </Box>
            );
          case "ol":
            return (
              <Box key={key} flexDirection="column">
                {(b.items ?? []).map((it, j) => (
                  <Text key={`${key}-${j}`}>
                    {`  ${j + 1}. `}
                    {renderInline(it, `${key}-${j}`)}
                  </Text>
                ))}
              </Box>
            );
          case "quote":
            return (
              <Box key={key} flexDirection="column" paddingLeft={2}>
                <Text color="gray">
                  │ {(b.text ?? "").split("\n").join("\n│ ")}
                </Text>
              </Box>
            );
          case "blank":
            return <Text key={key}> </Text>;
        }
      })}
    </Box>
  );
}