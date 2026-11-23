import { readFile } from "node:fs/promises";
import type { AgentMode, Event } from "../types.js";
import { stripThinking } from "../compaction/stripThinking.js";
import type { ChatProvider } from "../providers/types.js";
import { loadCwdFromDisk, readSessionJsonlText } from "./sessionIo.js";
import { sessionPath, titleSidecarPath } from "./sessionPaths.js";

/** Strip any XML/HTML-ish tags (and stray half-tags). Small models fed a
 * prompt that contains tool-call markup sometimes echo fragments like
 * `</arg_value>` or `<function_calls>` straight into the title. */
function stripTags(s: string): string {
  return s
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/gi, " ") // well-formed tags
    .replace(/<\/?[a-z][\w-]*/gi, " ") // unterminated opening half-tags
    .replace(/[a-z][\w-]*>/gi, " "); // unterminated closing half-tags
}

export function sanitizeTitle(raw: string): string | null {
  if (!raw) return null;
 // Small models (e.g. MiniMax) often stream chain-of-thought as
 // `<think…</think>` text_delta. That must never become the sidebar title.
  let t = stripThinking(raw);
 // Reject before stripping: a title that is *mostly* tags/markup is model
 // noise (tool-call echo), not a real title.
  if (/<\/?(?:think|thinking|redacted_reasoning)\b/i.test(t) || /^<think\b/i.test(t)) {
    return null;
  }
  t = stripTags(t);
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
 // Strip leading numbering like "1. " or "- ".
  t = t.replace(/^[\-\d.\)\s]+/, "");
 // Collapse whitespace.
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
 // Reject leftover meta-reasoning (English or Chinese) and echoed input that
 // is really a filesystem path, not a title.
  if (
    /^(we need|let me|i need|i'?ll|i will|the user|title only|according to|here is|here'?s|sure|okay|ok\b)/i.test(t) ||
    /^(用户|我需要|我来|我们需要|我会|根据|让我|首先|好的|标题[:：])/.test(t) ||
    /^(?:\/|~\/|[A-Za-z]:[\\/]|Users\/|home\/|\.{1,2}\/)/.test(t) ||
    isWeakTitleSource(t)
  ) {
    return null;
  }
 // Hard cap at 60 chars; the small model is asked for 10 but the fallback
 // may be longer. Truncate at a word boundary when possible.
  if (t.length > 60) {
    t = t.slice(0, 60);
    const lastSpace = t.lastIndexOf(" ");
    if (lastSpace > 30) t = t.slice(0, lastSpace);
    t = t.trimEnd() + "…";
  }
  return t;
}

/** Short acks / "continue" nudges must never become the title — they overwrite
 * a real first-prompt title when the late refresh re-derives it. */
export function isWeakTitleSource(text: string): boolean {
  const t = stripTags(text).replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  return /^(继续|續行|續|下一步|接着|接著|再来|再來|go on|continue|cont\.?|next|ok|okay|yes|y|好的?|行|嗯+|哦+|hai|please continue)[.!?。！？…]*$/i.test(
    t,
  );
}

export function deriveTitleFromText(text: string): string {
 // Drop tool-call markup and tags before deriving a fallback, so the
 // deterministic path can't leak `</arg_value>`-style fragments either.
  const clean = stripTags(text).replace(/\s+/g, " ").trim();
  if (!clean) return "(untitled)";
  if (isWeakTitleSource(clean)) return "(untitled)";
 // Prefer the first sentence.
  const firstSentence = clean.split(/[.?!。？！\n]/)[0] ?? clean;
  return firstSentence.slice(0, 60);
}

/** First user-visible prompt text in a transcript (skips weak nudges). */
export function firstTitleWorthyUserText(events: readonly Event[]): string | undefined {
  for (const e of events) {
    if (e.type !== "message" || e.role !== "user") continue;
    const first = e.content.find((b) => b.type === "text");
    if (!first || first.type !== "text") continue;
    const text = first.text.trim();
    if (!text || isWeakTitleSource(text)) continue;
    return text;
  }
  return undefined;
}

/** Does the first user message look like a pasted handoff / tool-call dump
 * rather than a natural request? Such inputs make small models echo markup
 * (e.g. `</arg_value>`), so we skip the model and use a deterministic title. */
function looksLikeMarkupDump(text: string): boolean {
  return (
    /<\/?(?:function_calls|invoke|parameter|arg_value|tool_call|antml:)/i.test(text) ||
    (text.match(/<\/?[a-z][\w-]*[^>]*>/gi)?.length ?? 0) >= 4
  );
}

export async function callTitleModel(
  provider: ChatProvider,
  userText: string,
  model: string | undefined
): Promise<string | null> {
 // For markup-heavy / pasted-dump inputs, don't risk the model echoing
 // tool-call tags — use the deterministic first-sentence title instead.
  if (looksLikeMarkupDump(userText)) return null;
  const sys =
    `You generate a short, neutral session title (≤10 Chinese chars or ≤60 ASCII chars). ` +
    `Output ONLY the title itself — no XML or HTML tags, no quotes, no punctuation, ` +
    `no preamble, no explanation, and do not repeat or quote the user's input.`;
 // Strip any tool-call markup from the input so it can't prime the model to
 // echo tags back; cap length to keep the request cheap.
  const prompt = stripTags(userText).replace(/\s+/g, " ").trim().slice(0, 2000);
  const collected: string[] = [];
  for await (const ev of provider.stream({
    model: model ?? provider.smallModel,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    systemPrompt: sys,
    maxTokens: 64,
  })) {
    if (ev.kind === "text_delta") collected.push(ev.text);
    if (ev.kind === "error") return null;
  }
  const joined = stripThinking(collected.join("")).trim();
  return joined || null;
}

export async function extractTitleAndMeta(
  path: string,
  id: string
): Promise<{
  title: string;
  cwd?: string;
  mode?: AgentMode;
  model?: string;
  messageCount: number;
}> {
  try {
    // Read live or cold transcript (the `path` arg is the live path; a cold
    // session is read transparently from its `.jsonl.br` by id).
    const text = (await readFile(path, "utf-8").catch(() => undefined)) ??
      (await readSessionJsonlText(id));
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    let title = "(untitled)";
    let firstUserText = "";
    let mode: AgentMode | undefined;
    let model: string | undefined;
    let messageCount = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as Event;
        if (e.type === "message") {
          if (e.role === "user" || e.role === "assistant") messageCount++;
          if (e.role === "user" && !firstUserText) {
            const first = e.content.find((b) => b.type === "text");
            if (first && first.type === "text") firstUserText = first.text;
          }
          if (e.role === "assistant" && e.model) model = e.model;
        } else if (e.type === "model" && e.model) {
          // Explicit model-change events win over assistant message.model.
          model = e.model;
        } else if (e.type === "mode") {
          mode = e.mode;
        }
      } catch {
 /* skip */
      }
    }
 // Prefer sidecar title.
    const sidecar = await loadTitleFromDisk(id);
    if (sidecar) title = sidecar;
    else if (firstUserText) title = firstUserText.slice(0, 80);
    const cwd = await loadCwdFromDisk(id);
    return { title, cwd, mode, model, messageCount };
  } catch {
    return { title: "(untitled)", messageCount: 0 };
  }
}

export async function loadTitleFromDisk(id: string): Promise<string | null> {
  try {
    const t = await readFile(titleSidecarPath(id), "utf-8");
    return t.trim() || null;
  } catch {
    return null;
  }
}