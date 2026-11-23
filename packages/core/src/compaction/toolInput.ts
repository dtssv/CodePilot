// Bound large tool-call arguments once when sealing the assistant tool_use.
// Execution keeps the full input in memory; the persisted tool_use carries a
// head+tail stub (+ artifact) so later turns do not inflate unc. Do not
// re-truncate on the send path — that rewrites mid-history relative to a
// previously cached full body and busts prefix cache.

/** Spill / truncate when serialized tool input exceeds this many characters. */
export const TOOL_INPUT_SPILL_CHARS = 4_000;
/** Head kept from each oversized string field. */
export const TOOL_INPUT_FIELD_HEAD = 700;
/** Tail kept from each oversized string field. */
export const TOOL_INPUT_FIELD_TAIL = 300;

/** Keys that commonly carry multi-KB payloads in tool args. */
const LARGE_INPUT_KEYS = new Set([
  "content",
  "new_string",
  "old_string",
  "patch",
  "code",
  "command",
  "query",
  "text",
  "body",
  "prompt",
  "file_text",
  "diff",
  "arguments",
  "script",
  "source",
  "data",
  "html",
  "markdown",
]);

const OMIT_MARK = "chars omitted from tool input";

export function measureToolInputChars(input: unknown): number {
  try {
    return JSON.stringify(input ?? null).length;
  } catch {
    return String(input ?? "").length;
  }
}

function fieldOmitMarker(omitted: number, artifactRef?: string): string {
  const ref = artifactRef
    ? `; full JSON in artifact ${artifactRef} — use read_artifact if you need a slice`
    : " for context size";
  return `\n\n[... ${omitted.toLocaleString()} ${OMIT_MARK}${ref} ...]\n\n`;
}

function truncateStringField(value: string, artifactRef?: string): string {
  const head = TOOL_INPUT_FIELD_HEAD;
  const tail = TOOL_INPUT_FIELD_TAIL;
  const omitted = value.length - head - tail;
  if (omitted <= 0) return value;
  return value.slice(0, head) + fieldOmitMarker(omitted, artifactRef) + value.slice(value.length - tail);
}

function alreadyTruncated(value: string): boolean {
  return value.includes(OMIT_MARK);
}

/**
 * Deterministic shrink of oversized tool-call arguments for the model view.
 * Preferentially clips known large string fields; falls back to any long
 * strings. Stable for the same input (cache-friendly once applied).
 */
export function truncateToolCallInput(
  input: unknown,
  opts: { artifactRef?: string; maxSerializedChars?: number } = {},
): unknown {
  const max = opts.maxSerializedChars ?? TOOL_INPUT_SPILL_CHARS;
  if (measureToolInputChars(input) <= max) return input;

  if (typeof input === "string") {
    return alreadyTruncated(input) ? input : truncateStringField(input, opts.artifactRef);
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    // Rare non-object payloads: keep a bounded JSON view.
    const raw = (() => {
      try {
        return JSON.stringify(input ?? null);
      } catch {
        return String(input);
      }
    })();
    if (raw.length <= max) return input;
    return {
      _truncated: true,
      preview: truncateStringField(raw, opts.artifactRef),
    };
  }

  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const shrinkKey = (key: string): void => {
    const v = out[key];
    if (typeof v !== "string" || v.length <= TOOL_INPUT_FIELD_HEAD + TOOL_INPUT_FIELD_TAIL) return;
    if (alreadyTruncated(v)) return;
    out[key] = truncateStringField(v, opts.artifactRef);
  };

  for (const key of Object.keys(out)) {
    if (LARGE_INPUT_KEYS.has(key)) shrinkKey(key);
  }
  if (measureToolInputChars(out) > max) {
    for (const key of Object.keys(out)) shrinkKey(key);
  }
  return out;
}

export type SpillToolCallInputResult = {
  input: unknown;
  artifactRef?: string;
  spilled: boolean;
  originalChars: number;
};

/**
 * When tool-call arguments exceed {@link TOOL_INPUT_SPILL_CHARS}, stash the
 * full JSON in an artifact and return a bounded view for the sealed tool_use
 * block. Below the threshold the input is returned unchanged.
 */
export async function spillToolCallInputForContext(
  input: unknown,
  toolName: string,
  writeArtifact: (content: string, hint: string) => Promise<string>,
): Promise<SpillToolCallInputResult> {
  const originalChars = measureToolInputChars(input);
  if (originalChars <= TOOL_INPUT_SPILL_CHARS) {
    return { input, spilled: false, originalChars };
  }
  let artifactRef: string | undefined;
  try {
    const body = (() => {
      try {
        return JSON.stringify(input ?? null);
      } catch {
        return String(input);
      }
    })();
    artifactRef = await writeArtifact(body, `tool_call_input:${toolName}`);
  } catch {
    /* artifact write is best-effort; still truncate the view */
  }
  return {
    input: truncateToolCallInput(input, { artifactRef }),
    artifactRef,
    spilled: true,
    originalChars,
  };
}
