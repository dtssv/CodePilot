import { detectDegenerateText } from "../compaction/textDegeneration.js";
import type { Event } from "../types.js";

/** Instruction block appended to the role when an output schema is
 * requested. Overrides the free-text conclusion format. */
export function structuredOutputBlock(schema: Record<string, unknown>): string {
  return `\n\n## Structured Output\n\nYou have been asked to return a STRUCTURED result. Your final assistant message must be a SINGLE JSON object matching this JSON schema — no markdown, no prose, no code fence, just the JSON:\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n\nIf you cannot complete the work, return \`{"error": "<one-sentence reason>"}\`. Do not include any text before or after the JSON object.`;
}

export const STRUCTURED_OUTPUT_FOOTER = `This is your only task. Your final assistant message must be a single JSON object matching the schema in your system prompt — no markdown, no prose, just the JSON.`;

/** Extract a JSON object from the sub-agent's final text. Tolerates leading
 * whitespace, a surrounding ```json fence, and trailing prose. Returns
 * {ok, value} on success or {ok:false, error} on failure. */
export function extractStructuredJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
 // Try direct parse first.
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
 /* fall through */
  }
 // Try a fenced ```json ... ``` block.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return { ok: true, value: JSON.parse(fenced[1]!.trim()) };
    } catch {
 /* fall through */
    }
  }
 // Try the first {...} balanced span.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch {
 /* fall through */
    }
  }
  return { ok: false, error: "no JSON object found in the conclusion" };
}

const NO_FINAL_TEXT = "(sub-agent produced no final text)";

function extractFinalText(events: Event[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "assistant") {
      const text = e.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return NO_FINAL_TEXT;
}

function extractErrors(events: Event[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "error" && e.message.trim()) out.push(e.message.trim());
  }
  return out;
}

function countSteps(events: Event[]): number {
  let n = 0;
  for (const e of events) if (e.type === "tool_call") n++;
  return n;
}

/**
 * Decide whether a sub-agent run produced a usable conclusion. Soft failures
 * (provider 404, empty stream, aborted mid-turn) surface as `ok: false` so
 * the parent does not keep exploring a failed sub-agent.
 */
export function assessSubagentOutcome(
  events: Event[],
  opts: { degenerationEnabled?: boolean } = {},
): {
  conclusion: string;
  steps: number;
  ok: boolean;
} {
  const steps = countSteps(events);
  const errors = extractErrors(events);
  const text = extractFinalText(events);
  const hasText = text !== NO_FINAL_TEXT;

  // Degenerate output (decoding collapse) is a failure, never a conclusion.
  // Caught before the "has text → ok" path so the garbage is not adopted or
  // fed back to the parent. Guards the incoherent-garbage form. Honours the
  // same enable gate as the live streaming guard, so disabling degeneration
  // detection turns off both checks.
  if (hasText && opts.degenerationEnabled !== false) {
    const degen = detectDegenerateText(text);
    if (degen) {
      return {
        ok: false,
        steps,
        conclusion:
          `### Blocker\n` +
          `Sub-agent output degenerated into repeated noise ` +
          `(the unit ${JSON.stringify(degen.unit)} covers ` +
          `${Math.round(degen.ratio * 100)}% of ${text.length} chars) ` +
          `after ${steps} tool step(s). The model collapsed into a decode loop ` +
          `instead of producing a conclusion — treat this run as failed and ` +
          `retry (optionally with a stronger model or a narrower objective).`,
      };
    }
    // Zero tool steps is a failure for an agentic sub-agent: text without any
    // tool call is an announcement of intent, not a result. Keyed off step
    // count (model- and language-agnostic), not a text-pattern match.
    if (steps === 0) {
      const snippet = text.length > 160 ? `${text.slice(0, 160)}…` : text;
      return {
        ok: false,
        steps,
        conclusion:
          `### Blocker\n` +
          `Sub-agent produced text but took 0 tool steps — it never read, ` +
          `searched, or ran anything, so it did no real work (the output is an ` +
          `announcement of intent, not a finding). Treat this run as failed and ` +
          `retry.\n\nWhat it said:\n${JSON.stringify(snippet)}`,
      };
    }
  }

  if (errors.length > 0 && !hasText) {
    return {
      ok: false,
      steps,
      conclusion:
        `### Blocker\n` +
        `Sub-agent failed before producing a conclusion` +
        (steps === 0 ? " (0 tool steps)." : ` (${steps} tool step(s) before failure).`) +
        `\n\nProvider/runtime errors:\n` +
        errors.map((m) => `- ${m}`).join("\n"),
    };
  }

  if (!hasText) {
    return {
      ok: false,
      steps,
      conclusion:
        `### Blocker\n` +
        `Sub-agent produced no final text` +
        (steps === 0
          ? " and took 0 tool steps — the model likely returned an empty/error response."
          : ` after ${steps} tool step(s).`),
    };
  }

  if (errors.length > 0) {
 // Model recovered enough to write a conclusion; keep ok but append errors
 // so the parent can see transient failures that happened mid-run.
    return {
      ok: true,
      steps,
      conclusion:
        text +
        `\n\n(note: sub-agent also recorded error event(s):\n` +
        errors.map((m) => `- ${m}`).join("\n") +
        `)`,
    };
  }

  return { ok: true, steps, conclusion: text };
}