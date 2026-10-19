// Minimal Markdown renderer for assistant messages.
//
// No parser dependency: the agent's output is overwhelmingly fenced code,
// inline code, lists and the odd table, and a small hand-rolled renderer
// keeps the bundle tiny and the failure mode boring (unknown syntax renders
// as plain text). Supports: fenced code blocks, headings, bullet / ordered /
// task lists, blockquotes, GFM tables, horizontal rules, and inline code /
// bold / italic / strikethrough / links. Raw HTML is escaped by React — it is
// never interpreted.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { t } from "../i18n.js";
import { splitThinking } from "../state/stripThinking.js";
import { CheckIcon, ChevronIcon, CopyIcon } from "./Icons.js";

export function Markdown({ text }: { text: string }): React.ReactElement {
  const segments = useMemo(() => splitThinking(text), [text]);
  if (segments.length === 0) {
    return <div className="cp-md text-[13.5px] leading-[1.7] text-[var(--color-ink-faint)]" />;
  }
  return (
    <div className="cp-md space-y-2.5 text-[13.5px] leading-[1.7] break-words text-[var(--color-ink)]">
      {segments.map((seg, i) =>
        seg.kind === "think" ? (
          <ThinkingFold key={i} text={seg.text} incomplete={seg.incomplete} />
        ) : (
          <MarkdownBody key={i} text={seg.text} />
        ),
      )}
    </div>
  );
}

function MarkdownBody({ text }: { text: string }): React.ReactElement | null {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (blocks.length === 0) return null;
  return <>{blocks.map(renderBlock)}</>;
}

/** Collapsed by default; click to reveal model chain-of-thought. */
function ThinkingFold({ text, incomplete }: { text: string; incomplete?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(!!incomplete);
  const wasIncomplete = useRef(!!incomplete);
  useEffect(() => {
    if (incomplete) {
      setOpen(true);
    } else if (wasIncomplete.current) {
      setOpen(false);
    }
    wasIncomplete.current = !!incomplete;
  }, [incomplete]);

  const label = incomplete ? t("Thinking") : t("Thought");
  return (
    <div className="my-0.5">
      <button
        type="button"
        aria-expanded={open}
        title={open ? t("Hide thinking") : t("Show thinking")}
        onClick={() => setOpen((v) => !v)}
        className="group/think inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink-dim)]"
      >
        <ChevronIcon open={open} className="h-3 w-3 shrink-0 opacity-70" />
        <span className={incomplete ? "animate-pulse" : undefined}>{label}</span>
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-[var(--color-edge)] pl-3 text-[12.5px] leading-[1.65] whitespace-pre-wrap text-[var(--color-ink-faint)]">
          {text.trim() || (incomplete ? "…" : "")}
        </div>
      )}
    </div>
  );
}

// ----- block model -----------------------------------------------------------

type Align = "left" | "center" | "right" | undefined;

type Block =
  | { kind: "code"; lang?: string; lines: string[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: Array<{ text: string; task?: boolean; done?: boolean }> }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "rule" }
  | { kind: "para"; text: string };

const CODE_FENCE = /^(`{3,})([^\n`]*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Collect a fenced code block. Nested fences (e.g. a ```python example inside
 * a ```python doc) stay in the body: a bare closer only ends the block when
 * nest depth is back to zero. Matches CommonMark's "same or longer" rule for
 * the outer fence length.
 */
function readFence(
  lines: string[],
  start: number,
): { lang?: string; body: string[]; end: number } | null {
  const open = (lines[start] ?? "").trim().match(CODE_FENCE);
  if (!open) return null;
  const tick = open[1]!.length;
  const lang = open[2]!.trim() || undefined;
  const body: string[] = [];
  let depth = 1;
  let i = start + 1;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    const fence = trimmed.match(CODE_FENCE);
    if (fence && fence[1]!.length >= tick) {
      const info = fence[2]!.trim();
      if (info) {
 // ```python inside the body — nested open, keep as content.
        depth++;
        body.push(raw);
        i++;
        continue;
      }
      depth--;
      if (depth === 0) {
        return { lang, body, end: i };
      }
 // Closes an inner fence; keep the line so the example stays intact.
      body.push(raw);
      i++;
      continue;
    }
    body.push(raw);
    i++;
  }
  return { lang, body, end: Math.max(start, lines.length - 1) };
}

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (CODE_FENCE.test(line.trim())) {
      const fence = readFence(lines, i);
      if (fence) {
        blocks.push({ kind: "code", lang: fence.lang, lines: fence.body });
        i = fence.end + 1;
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: Math.min(4, heading[1]?.length ?? 1) as 1 | 2 | 3 | 4,
        text: (heading[2] ?? "").replace(/\s+#+\s*$/, ""),
      });
      i++;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1] ?? "").map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const start = ordered ? Number(line.trim().match(/^\d+/)?.[0] ?? 1) : 1;
      const items: Array<{ text: string; task?: boolean; done?: boolean }> = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (m) {
          const body = m[1] ?? "";
          const task = body.match(/^\[([ xX])\]\s+(.*)$/);
          items.push(task ? { text: task[2] ?? "", task: true, done: task[1] !== " " } : { text: body });
          i++;
          continue;
        }
 // Indented continuation lines belong to the current item.
        if (l.trim() !== "" && items.length > 0 && /^\s{2,}/.test(l)) {
          items[items.length - 1]!.text += ` ${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }

 // Paragraph: consecutive non-empty lines that are not another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !CODE_FENCE.test((lines[i] ?? "").trim()) &&
      !/^(#{1,6})\s/.test(lines[i] ?? "") &&
      !(para.length > 0 && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i] ?? ""))
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ kind: "para", text: para.join("\n") });
  }

  return blocks;
}

// ----- rendering -------------------------------------------------------------

const HEADING_SIZE = ["text-[17px]", "text-[15.5px]", "text-[14px]", "text-[13.5px]"];

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.kind) {
    case "code":
      return <CodeBlock key={i} lang={b.lang} code={b.lines.join("\n")} />;
    case "heading":
      return (
        <div key={i} className={`${HEADING_SIZE[b.level - 1]} pt-1 font-semibold tracking-tight text-[var(--color-ink)]`}>
          {inline(b.text)}
        </div>
      );
    case "list": {
      const items = b.items.map((it, j) => (
        <li key={j} className={it.task ? "flex list-none items-start gap-2 -ml-5" : "pl-0.5"}>
          {it.task && (
            <span
              className={`mt-[5px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                it.done ? "border-[var(--color-add)] bg-[var(--color-add)] text-white" : "border-[var(--color-edge)]"
              }`}
            >
              {it.done && <CheckIcon className="h-2.5 w-2.5" />}
            </span>
          )}
          <span className={it.done ? "text-[var(--color-ink-faint)] line-through" : undefined}>{inline(it.text)}</span>
        </li>
      ));
      return b.ordered ? (
        <ol key={i} start={b.start} className="ml-5 list-decimal space-y-1 marker:text-[var(--color-ink-faint)]">
          {items}
        </ol>
      ) : (
        <ul key={i} className="ml-5 list-disc space-y-1 marker:text-[var(--color-ink-faint)]">
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote key={i} className="border-l-[3px] border-[var(--color-accent)]/50 pl-3 whitespace-pre-wrap text-[var(--color-ink-dim)]">
          {inline(b.text)}
        </blockquote>
      );
    case "table":
      return (
        <div key={i} className="overflow-x-auto rounded-lg border border-[var(--color-edge-subtle)]">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-[var(--color-surface-sunken)]">
              <tr>
                {b.header.map((h, j) => (
                  <th
                    key={j}
                    style={{ textAlign: b.align[j] ?? "left" }}
                    className="border-b border-[var(--color-edge-subtle)] px-3 py-1.5 font-semibold text-[var(--color-ink)]"
                  >
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className="border-b border-[var(--color-edge-subtle)] last:border-b-0">
                  {b.header.map((_, j) => (
                    <td key={j} style={{ textAlign: b.align[j] ?? "left" }} className="px-3 py-1.5 align-top text-[var(--color-ink-dim)]">
                      {inline(r[j] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={i} className="border-[var(--color-edge-subtle)]" />;
    case "para":
      return (
        <p key={i} className="whitespace-pre-wrap">
          {inline(b.text)}
        </p>
      );
  }
}

function CodeBlock({ lang, code }: { lang?: string; code: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code overflow-hidden rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)]">
      <div className="flex items-center border-b border-[var(--color-edge-subtle)] px-3 py-1">
        <span className="font-mono text-[10.5px] tracking-wide text-[var(--color-ink-faint)] lowercase">{lang || "text"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="ml-auto flex items-center gap-1 rounded px-1 text-[10.5px] text-[var(--color-ink-faint)] opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-[var(--color-ink)]"
          title="Copy"
        >
          {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-5 text-[var(--color-ink)]">{code}</pre>
    </div>
  );
}

/**
 * Inline pass: `code`, **bold**, *italic*, ~~strike~~, [links](url). A
 * left-to-right regex alternation; anything unmatched is plain text (escaped
 * by React). Bold/italic/link text is parsed recursively so `**a `b`**` works.
 */
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|(\*[^*\n]+\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string): ReactNode {
  if (!/[*`_~[]|https?:/.test(text)) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const part = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(<Fragment key={k++}>{text.slice(last, at)}</Fragment>);
    last = at + part.length;
    if (m[1]) {
      out.push(
        <code key={k++} className="rounded-md bg-[var(--color-surface-sunken)] px-1.5 py-0.5 font-mono text-[0.86em] text-[var(--color-accent)]">
          {part.slice(1, -1)}
        </code>,
      );
    } else if (m[2] || m[3]) {
      out.push(<strong key={k++} className="font-semibold">{inline(part.slice(2, -2))}</strong>);
    } else if (m[4]) {
      out.push(<del key={k++} className="text-[var(--color-ink-faint)]">{inline(part.slice(2, -2))}</del>);
    } else if (m[5]) {
      const mm = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(<Link key={k++} href={mm?.[2] ?? "#"}>{inline(mm?.[1] ?? part)}</Link>);
    } else if (m[6]) {
      out.push(<em key={k++}>{inline(part.slice(1, -1))}</em>);
    } else if (m[7]) {
      out.push(<Link key={k++} href={part}>{part}</Link>);
    }
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return <Fragment>{out}</Fragment>;
}

function Link({ href, children }: { href: string; children: ReactNode }): React.ReactElement {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/30 underline-offset-2 hover:decoration-[var(--color-accent)]">
      {children}
    </a>
  );
}
