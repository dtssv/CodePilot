/**
 * Browser-safe copy of core reasoning-effort heuristics (no Node imports).
 * Keep in sync with `packages/core/src/reasoningEffort.ts`.
 */

export type ReasoningEffort = "low" | "medium" | "high";
export type ReasoningEffortChoice = "off" | ReasoningEffort;

const ALL_WITH_OFF: ReasoningEffortChoice[] = ["off", "low", "medium", "high"];
const OPENAI_STYLE: ReasoningEffortChoice[] = ["low", "medium", "high"];

export function reasoningEffortChoicesForModel(
  model: string,
  provider?: string,
): ReasoningEffortChoice[] {
  const m = model.trim().toLowerCase();
  if (!m) return [];
  const p = (provider ?? "").trim().toLowerCase();

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

  if (m.includes("deepseek-r") || m.includes("reasoner") || /(?:^|[^a-z])r1(?:[^a-z]|$)/.test(m)) {
    return OPENAI_STYLE;
  }

  if (m.includes("gemini") && (m.includes("2.5") || m.includes("2-5") || m.includes("thinking"))) {
    return ALL_WITH_OFF;
  }

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

  if (m.includes("thinking") || m.includes("reason")) {
    return ALL_WITH_OFF;
  }

  return [];
}

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
