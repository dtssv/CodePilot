/**
 * Per-model reasoning / extended-thinking effort levels.
 *
 * OpenAI o-series & Anthropic extended thinking both map onto the shared
 * `reasoningEffort` config knob; which levels a model accepts is heuristic
 * based on the model id (and optional provider hint).
 */

export type ReasoningEffort = "low" | "medium" | "high";

/** UI levels: `off` clears effort; others map 1:1 to {@link ReasoningEffort}. */
export type ReasoningEffortChoice = "off" | ReasoningEffort;

const ALL_WITH_OFF: ReasoningEffortChoice[] = ["off", "low", "medium", "high"];
const OPENAI_STYLE: ReasoningEffortChoice[] = ["low", "medium", "high"];

/**
 * Which thinking-intensity choices make sense for this model.
 * Empty → the model does not expose a controllable effort knob in the UI.
 */
export function reasoningEffortChoicesForModel(
  model: string,
  provider?: string,
): ReasoningEffortChoice[] {
  const m = model.trim().toLowerCase();
  if (!m) return [];
  const p = (provider ?? "").trim().toLowerCase();

  // OpenAI / compatible reasoning models (o1, o3, o4, gpt-5, …).
  if (
    /(?:^|[/_.-])o[1-9]\b/.test(m) ||
    m.includes("o1-") ||
    m.includes("o3-") ||
    m.includes("o4-") ||
    m.includes("gpt-5") ||
    m.includes("codex-") ||
    /(^|[^a-z])o1([^a-z]|$)/.test(m) ||
    /(^|[^a-z])o3([^a-z]|$)/.test(m) ||
    /(^|[^a-z])o4([^a-z]|$)/.test(m)
  ) {
    return OPENAI_STYLE;
  }

  // DeepSeek reasoner / R1 family.
  if (m.includes("deepseek-r") || m.includes("reasoner") || /(?:^|[^a-z])r1(?:[^a-z]|$)/.test(m)) {
    return OPENAI_STYLE;
  }

  // Gemini 2.5+ thinking budgets.
  if (m.includes("gemini") && (m.includes("2.5") || m.includes("2-5") || m.includes("thinking"))) {
    return ALL_WITH_OFF;
  }

  // Anthropic Claude with extended thinking (Sonnet/Opus 3.7+, 4.x).
  const isClaude = p === "anthropic" || m.includes("claude");
  if (isClaude) {
    if (m.includes("haiku") && !m.includes("thinking")) return [];
    if (
      m.includes("opus") ||
      m.includes("sonnet") ||
      m.includes("3-7") ||
      m.includes("3.7") ||
      m.includes("4-") ||
      m.includes("4.") ||
      /\b4\b/.test(m) ||
      m.includes("thinking")
    ) {
      return ALL_WITH_OFF;
    }
  }

  // Explicit "thinking" in the id (gateway aliases).
  if (m.includes("thinking") || m.includes("reason")) {
    return ALL_WITH_OFF;
  }

  return [];
}

export function supportsReasoningEffort(model: string, provider?: string): boolean {
  return reasoningEffortChoicesForModel(model, provider).length > 0;
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
