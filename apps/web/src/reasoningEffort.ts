/**
 * Browser-safe copy of core reasoning-effort heuristics (no Node imports).
 * Keep in sync with `packages/core/src/reasoningEffort.ts` and the declarative
 * capability table in `packages/core/src/modelCatalog.ts`.
 */

export type ReasoningEffort = "low" | "medium" | "high";
export type ReasoningEffortChoice = "off" | ReasoningEffort;

const ALL_WITH_OFF: ReasoningEffortChoice[] = ["off", "low", "medium", "high"];
const OPENAI_STYLE: ReasoningEffortChoice[] = ["low", "medium", "high"];
const NONE: ReasoningEffortChoice[] = [];

/** Browser-safe mirror of the core model catalog's effort tiers, keyed by id
 * glob (`*`/`?`, case insensitive, provider-prefix tolerant). Most-specific
 * entries first. Keep aligned with `MODEL_CATALOG`. */
const CATALOG_EFFORT: { patterns: string[]; effort: ReasoningEffortChoice[] }[] = [
  { patterns: ["gpt-5*", "o1*", "o3*", "o4*", "codex-*"], effort: OPENAI_STYLE },
  { patterns: ["gpt-4o*", "gpt-4.1*", "gpt-4-turbo*"], effort: NONE },
  { patterns: ["gpt-4*", "gpt-3*"], effort: NONE },
  { patterns: ["*opus*", "*sonnet*"], effort: ALL_WITH_OFF },
  { patterns: ["*haiku*"], effort: NONE },
  { patterns: ["deepseek-r*", "*reasoner*"], effort: OPENAI_STYLE },
  { patterns: ["deepseek*"], effort: NONE },
  { patterns: ["gemini-2.5*", "gemini-2-5*", "*gemini*thinking*"], effort: ALL_WITH_OFF },
  { patterns: ["gemini*"], effort: NONE },
  { patterns: ["glm-z*", "glm-zero*"], effort: OPENAI_STYLE },
  { patterns: ["glm*"], effort: NONE },
  { patterns: ["kimi*", "moonshot*"], effort: NONE },
];

/** Anchored glob matcher mirroring core's `modelGlobMatch`. */
function globMatch(pattern: string, id: string): boolean {
  const re =
    "^" +
    pattern
      .split(/(\*|\?)/)
      .map((part) =>
        part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("") +
    "$";
  let rx: RegExp;
  try {
    rx = new RegExp(re, "i");
  } catch {
    return false;
  }
  if (rx.test(id)) return true;
  const slash = id.lastIndexOf("/");
  return slash >= 0 && rx.test(id.slice(slash + 1));
}

function catalogEffort(id: string): ReasoningEffortChoice[] | undefined {
  for (const entry of CATALOG_EFFORT) {
    if (entry.patterns.some((p) => globMatch(p, id))) return entry.effort;
  }
  return undefined;
}

export function reasoningEffortChoicesForModel(
  model: string,
  provider?: string,
): ReasoningEffortChoice[] {
  const m = model.trim().toLowerCase();
  if (!m) return [];

  // The declarative catalog wins for known models; heuristics cover the rest.
  const declared = catalogEffort(m);
  if (declared) return [...declared];

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
