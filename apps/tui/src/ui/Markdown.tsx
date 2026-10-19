/**
 * Minimal markdown renderer for Ink.
 *
 * Handles a pragmatic subset well enough for assistant messages:
 * - fenced code blocks ```lang … ```
 * - inline code `…`
 * - **bold** and *italic*
 * - headings (# … ######)
 * - lists (-, *, 1.)
 * - blockquotes (> )
 * - links [text](url)
 * - tables (| a | b |)
 *
 * The renderer is pure (no I/O); colors come from theme.ts.
 */
import React from "react";
import { Text, Box } from "ink";
import { splitThinking, type ThinkingSegment } from "@codepilot/core";
import { color as palette } from "./theme.js";

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
          <Text key={k} color={palette.info}>
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
          <Text key={k} color={palette.info} underline>
            {t.value}
          </Text>
        );
    }
  });
}

interface Block {
  kind: "heading" | "paragraph" | "code" | "ul" | "ol" | "quote" | "table" | "blank";
  level?: number;
  lang?: string;
  items?: string[];
  text?: string;
  rows?: string[][];
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
 // Fenced code — nested ```lang inside the body stays in the body;
 // a bare closer only ends the block when nest depth returns to zero.
    if (line.trimStart().startsWith("```")) {
      const open = line.trim().match(/^(`{3,})([^\n`]*)$/);
      const tick = open?.[1]?.length ?? 3;
      const lang = (open?.[2] ?? "").trim();
      const buf: string[] = [];
      let depth = 1;
      i++;
      while (i < lines.length) {
        const raw = lines[i]!;
        const fence = raw.trim().match(/^(`{3,})([^\n`]*)$/);
        if (fence && fence[1]!.length >= tick) {
          const info = fence[2]!.trim();
          if (info) {
            depth++;
            buf.push(raw);
            i++;
            continue;
          }
          depth--;
          if (depth === 0) break;
          buf.push(raw);
          i++;
          continue;
        }
        buf.push(raw);
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
 // Table: header row, rule, body rows
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const rows = [tableCells(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) {
        rows.push(tableCells(lines[i]!));
        i++;
      }
      blocks.push({ kind: "table", rows });
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
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
 // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""));
        i++;
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
      !lines[i]!.startsWith("> ") &&
      !TABLE_ROW.test(lines[i]!)
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

/** Spacing comes from the source's blank lines only: trim and collapse them. */
function tidy(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "blank" && (out.length === 0 || out[out.length - 1]!.kind === "blank")) continue;
    out.push(b);
  }
  while (out.length > 0 && out[out.length - 1]!.kind === "blank") out.pop();
  return out;
}

/** Ink has no click targets — show a one-line preview; full fold lives in the web UI. */
function ThinkingFold({ text, incomplete }: { text: string; incomplete?: boolean }): React.ReactElement {
  const body = text.trim();
  const first = body.split("\n")[0] ?? "";
  const preview = first.length > 72 ? `${first.slice(0, 72)}…` : first;
  const label = incomplete ? "Thinking" : "Thought";
  return (
    <Text dimColor color={palette.faint}>
      ▸ {label}
      {preview ? ` · ${preview}` : incomplete ? "…" : ""}
    </Text>
  );
}

function MarkdownBlocks({ text, dimColor }: { text: string; dimColor?: boolean }): React.ReactElement {
  const blocks = tidy(parseBlocks(text));
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        const key = `b-${i}`;
        switch (b.kind) {
          case "heading": {
            const text = b.text ?? "";
            return (
              <Box key={key}>
                <Text bold color={b.level === 1 ? palette.accent : undefined} dimColor={(b.level ?? 1) >= 4}>
                  {text}
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
                borderColor={palette.edge}
                flexDirection="column"
                paddingX={1}
              >
                {(b.lang ?? "") !== "" ? (
                  <Text color={palette.faint}>
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
                    <Text color={palette.accent}>{"  • "}</Text>
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
                    <Text color={palette.faint}>{`  ${j + 1}. `}</Text>
                    {renderInline(it, `${key}-${j}`)}
                  </Text>
                ))}
              </Box>
            );
          case "table":
            return <Table key={key} rows={b.rows ?? []} />;
          case "quote":
            return (
              <Box key={key} flexDirection="column" paddingLeft={2}>
                <Text color={palette.faint}>
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

export function Markdown({ children, dimColor }: MarkdownProps): React.ReactElement {
  const segments: ThinkingSegment[] = splitThinking(children);
  return (
    <Box flexDirection="column">
      {segments.map((seg, i) =>
        seg.kind === "think" ? (
          <ThinkingFold key={`t-${i}`} text={seg.text} incomplete={seg.incomplete} />
        ) : (
          <MarkdownBlocks key={`m-${i}`} text={seg.text} dimColor={dimColor} />
        ),
      )}
    </Box>
  );
}

/** Plain-text width, ignoring inline markup characters. */
function cellWidth(cell: string): number {
  return parseInline(cell).reduce((n, t) => n + [...t.value].reduce((w, ch) => w + (/[\u1100-\uffff]/.test(ch) ? 2 : 1), 0), 0);
}

function Table({ rows }: { rows: string[][] }): React.ReactElement {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map((r) => cellWidth(r[c] ?? ""))));
  const line = (r: string[], ri: number): React.ReactElement => (
    <Text key={`r-${ri}`}>
      {widths.map((w, c) => {
        const cell = r[c] ?? "";
        const pad = " ".repeat(Math.max(0, w - cellWidth(cell)));
        return (
          <Text key={c}>
            {c > 0 ? <Text color={palette.faint}>{"  "}</Text> : null}
            <Text bold={ri === 0}>{renderInline(cell, `t-${ri}-${c}`)}</Text>
            {pad}
          </Text>
        );
      })}
    </Text>
  );
  return (
    <Box flexDirection="column">
      {line(rows[0] ?? [], 0)}
      <Text color={palette.edge}>{widths.map((w) => "─".repeat(w)).join("──")}</Text>
      {rows.slice(1).map((r, i) => line(r, i + 1))}
    </Box>
  );
}
