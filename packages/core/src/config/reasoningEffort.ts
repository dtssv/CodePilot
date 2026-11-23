/** Per-model reasoning/extended-thinking effort levels.
 *
 * No static vendor catalog: choices come from optional per-model config
 * (`modelCapabilities.reasoningEffortChoices`) first, then version-agnostic
 * id heuristics (+ provider hint). New providers/models do not require a
 * core table edit. */

export type ReasoningEffort = "low" | "medium" | "high";

/** UI levels: `off` clears effort; others map 1:1 to {@link ReasoningEffort}. */
export type ReasoningEffortChoice = "off" | ReasoningEffort;

const ALL_WITH_OFF: ReasoningEffortChoice[] = ["off", "low", "medium", "high"];
const OPENAI_STYLE: ReasoningEffortChoice[] = ["low", "medium", "high"];

/** Optional override from provider `modelCapabilities[model]`. */
export type ReasoningEffortCaps = {
  reasoningEffortChoices?: readonly ReasoningEffortChoice[];
};

/** Bare model name after the last `/` (gateway prefixes like `openrouter/…`). */
function bareModelId(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Parse `gpt-N` major version from an id (basename). Returns undefined if not gpt. */
function gptMajorVersion(id: string): number | undefined {
  const m = /\bgpt-(\d+)\b/i.exec(id);
  if (!m) return undefined;
  return Number(m[1]);
}

/** Known non-reasoning GPT families (vision/chat without controllable effort). */
function isNonReasoningGpt(id: string): boolean {
  return (
    /\bgpt-4o\b/i.test(id) ||
    /\bgpt-4\.1\b/i.test(id) ||
    /\bgpt-4-turbo\b/i.test(id) ||
    /\bgpt-3\b/i.test(id) ||
    // Plain gpt-4* that is not 4o / 4.1 / 4-turbo (already matched above).
    (/\bgpt-4\b/i.test(id) && !/\bgpt-4o\b/i.test(id) && !/\bgpt-4\.1\b/i.test(id) && !/\bgpt-4-turbo\b/i.test(id))
  );
}

/** Gemini major.minor from id, or undefined. Treats `2-5` as 2.5. */
function geminiVersion(id: string): number | undefined {
  const dotted = /gemini[_-]?(\d+)\.(\d+)/i.exec(id);
  if (dotted) return Number(dotted[1]) + Number(dotted[2]) / 10;
  const dashed = /gemini[_-]?(\d+)-(\d+)/i.exec(id);
  if (dashed) return Number(dashed[1]) + Number(dashed[2]) / 10;
  const majorOnly = /gemini[_-]?(\d+)(?:[^0-9.]|$)/i.exec(id);
  if (majorOnly) return Number(majorOnly[1]);
  return undefined;
}

/**
 * Which thinking-intensity choices make sense for this model.
 * Empty → the model does not expose a controllable effort knob in the UI.
 *
 * Precedence: explicit caps override → id / provider heuristics.
 */
export function reasoningEffortChoicesForModel(
  model: string,
  provider?: string,
  caps?: ReasoningEffortCaps | null,
): ReasoningEffortChoice[] {
  if (caps?.reasoningEffortChoices) {
    return [...caps.reasoningEffortChoices];
  }

  const m = model.trim().toLowerCase();
  if (!m) return [];
  const bare = bareModelId(m);
  const p = (provider ?? "").trim().toLowerCase();

  // OpenAI o-series / Codex.
  if (
    /(?:^|[/_.-])o[1-9]\b/.test(m) ||
    bare.includes("o1-") ||
    bare.includes("o3-") ||
    bare.includes("o4-") ||
    bare.includes("codex-") ||
    /(^|[^a-z])o1([^a-z]|$)/.test(bare) ||
    /(^|[^a-z])o3([^a-z]|$)/.test(bare) ||
    /(^|[^a-z])o4([^a-z]|$)/.test(bare)
  ) {
    return OPENAI_STYLE;
  }

  // GPT: major ≥ 5 has effort; 4o / 4.1 / 4-turbo / 3.x / plain 4 do not.
  const gptMaj = gptMajorVersion(bare) ?? gptMajorVersion(m);
  if (gptMaj !== undefined) {
    if (isNonReasoningGpt(bare) || isNonReasoningGpt(m)) return [];
    if (gptMaj >= 5) return OPENAI_STYLE;
    return [];
  }

  // DeepSeek reasoner / R1 family.
  if (
    bare.includes("deepseek-r") ||
    m.includes("deepseek-r") ||
    bare.includes("reasoner") ||
    m.includes("reasoner") ||
    /(?:^|[^a-z])r1(?:[^a-z]|$)/.test(bare)
  ) {
    return OPENAI_STYLE;
  }

  // Gemini: thinking marker or version ≥ 2.5.
  if (bare.includes("gemini") || m.includes("gemini")) {
    if (bare.includes("thinking") || m.includes("thinking")) return ALL_WITH_OFF;
    const ver = geminiVersion(bare) ?? geminiVersion(m);
    if (ver !== undefined && ver >= 2.5) return ALL_WITH_OFF;
    return [];
  }

  // Anthropic Claude with extended thinking (Sonnet/Opus 3.7+, 4.x).
  const isClaude = p === "anthropic" || bare.includes("claude") || m.includes("claude");
  if (isClaude) {
    if ((bare.includes("haiku") || m.includes("haiku")) && !m.includes("thinking")) {
      return [];
    }
    if (
      bare.includes("opus") ||
      bare.includes("sonnet") ||
      m.includes("opus") ||
      m.includes("sonnet") ||
      m.includes("3-7") ||
      m.includes("3.7") ||
      /(?:^|[^a-z])4(?:[-.]|$)/.test(bare) ||
      m.includes("thinking")
    ) {
      return ALL_WITH_OFF;
    }
  }

  // Explicit "thinking" / "reason" in the id (gateway aliases, GLM-zero, …).
  if (m.includes("thinking") || /\breason(?:ing|er)?\b/.test(bare) || m.includes("reasoner")) {
    return ALL_WITH_OFF;
  }

  return [];
}

export function supportsReasoningEffort(
  model: string,
  provider?: string,
  caps?: ReasoningEffortCaps | null,
): boolean {
  return reasoningEffortChoicesForModel(model, provider, caps).length > 0;
}

/** Map a UI choice onto the config value (`undefined` = thinking off). */
export function reasoningEffortFromChoice(
  choice: ReasoningEffortChoice | null | undefined,
): ReasoningEffort | undefined {
  if (!choice || choice === "off") return undefined;
  return choice;
}

export function reasoningEffortToChoice(
  effort: ReasoningEffort | undefined | null,
): ReasoningEffortChoice {
  if (!effort) return "off";
  return effort;
}
