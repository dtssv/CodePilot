// Inline (Tab) code completion — the headless, provider-agnostic pieces.
//
// The protocol layer owns provider
// resolution and the network call (mirroring handleGitCommitMessage); this
// module owns the *pure* logic so it is unit-testable with no provider:
//   1. the model gate (never run as-you-type completion on the main model),
//   2. the scenario-neutral prompt builder,
//   3. output cleanup + small-block truncation.
//
// Phase 1 uses the prompted-chat path over the existing ChatProvider. The shapes
// here are FIM-ready (prefix + suffix) so phase 2 can swap in a native FIM call
// behind the same seam without touching the editors.

/** Request shape the completion handler works from (editor-supplied, capped). */
export interface InlineCompletionInput {
  /** Text before the cursor (already length-capped by the client). */
  prefix: string;
  /** Text after the cursor (FIM-ready; the chat path uses it as trailing context). */
  suffix: string;
  /** Workspace-relative path of the edited file — for language inference only. */
  path: string;
}

/** Decision of the model gate (design §2.5). */
export type CompletionModelDecision =
  | { run: true; model: string }
  | { run: false; disabledReason: "no-small-model" };

/**
 * The single most important correctness point (design §2.5): completion must
 * run on a genuinely lightweight model, never the main chat model. Because
 * `smallModel` falls back to the main `model` when the user has not configured
 * one (session-utils.ts), we refuse to run when the resolved small model is not
 * distinct from the main model and let the client prompt the user to configure
 * a lightweight/free completion model.
 *
 * An explicit `completionModel` override (same provider/apiKey) always wins and
 * is never gated — the user opted into a specific model.
 */
export function decideCompletionModel(opts: {
  /** Resolved main chat model (provider.defaultModel / session model). */
  mainModel: string;
  /** Resolved small model (may equal mainModel when unconfigured). */
  smallModel: string;
  /** Optional explicit completion-model override from config. */
  completionModel?: string;
}): CompletionModelDecision {
  const override = opts.completionModel?.trim();
  if (override) return { run: true, model: override };
  const small = opts.smallModel?.trim();
  const main = opts.mainModel?.trim();
  if (!small || small === main) return { run: false, disabledReason: "no-small-model" };
  return { run: true, model: small };
}

/** System prompt for the chat completion path. Scenario-neutral: no language,
 * framework, or project shape is hardcoded — everything is derived from the
 * editor payload. */
export const COMPLETION_SYSTEM_PROMPT =
  "You are a code completion engine. Given the code before and after the cursor, " +
  "output ONLY the text to insert at the cursor. Do not explain, do not use " +
  "markdown fences, and do not repeat the surrounding code. Continue naturally " +
  "from the code before the cursor so it joins the code after the cursor. If no " +
  "useful completion is warranted, output nothing.";

/** Build the user message for the chat completion path. The basename is passed
 * for language inference; we never inject a hardcoded language. */
export function buildCompletionPrompt(input: InlineCompletionInput): string {
  const base = basename(input.path);
  const header = base ? `File: ${base}\n` : "";
  return `${header}<|before|>${input.prefix}<|cursor|>${input.suffix}<|after|>`;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/**
 * Clean a raw model response and truncate it to a small code block (design §4).
 *
 * - strips a wrapping markdown fence the model may add despite instructions,
 * - trims a leading newline (the model often echoes the cursor's line break),
 * - truncates to a small code block: stop at the first blank-line run, and cap
 *   at `COMPLETION_MAX_LINES` lines so the suggestion is a few lines rather than
 *   a whole function. Deliberately language-neutral — no brace/indent heuristic
 *   that would assume a syntax (project scenario-neutrality principle).
 *
 * `prefix` is accepted for future use (e.g. de-duplicating a repeated line) and
 * to keep the phase-2 FIM swap signature-compatible; it is unused today.
 */
export function cleanCompletion(raw: string, _prefix: string): string {
  let text = stripFence(raw);
  // Drop a single leading newline the model may prepend (cursor line break).
  if (text.startsWith("\n")) text = text.slice(1);
  if (text.trim() === "") return "";

  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    // A blank line ends the small block — but only after we've taken content,
    // so a leading blank doesn't abort immediately.
    if (line.trim() === "") {
      if (out.length > 0) break;
      continue;
    }
    out.push(line);
    if (out.length >= COMPLETION_MAX_LINES) break;
  }
  return out.join("\n").replace(/\s+$/, "");
}

function stripFence(raw: string): string {
  const t = raw.trim();
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(t);
  return fence ? fence[1]! : raw;
}

/** Default soft cap on completion length (tokens). Small by design (§4). */
export const COMPLETION_MAX_TOKENS = 96;

/** Hard cap on completion lines — the "small block" ceiling (design §4). */
export const COMPLETION_MAX_LINES = 8;
