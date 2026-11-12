/** Declarative model-capability catalog: reasoning-effort tiers, input
 * modalities, and a suggested "small" companion model, keyed by id glob
 * (`*`/`?`, case-insensitive), most-specific-first. Advisory — a live `/models`
 * probe wins; unmatched ids fall back to id heuristics. */

import { modelGlobMatch } from "./tools/modes.js";
import type { ModelModality } from "./config.js";
import type { ReasoningEffortChoice } from "./reasoningEffort.js";

/** The reasoning-effort tier sets a catalog entry can advertise. */
const ALL_WITH_OFF: ReasoningEffortChoice[] = ["off", "low", "medium", "high"];
const OPENAI_STYLE: ReasoningEffortChoice[] = ["low", "medium", "high"];
const NONE: ReasoningEffortChoice[] = [];

/** Structured, declarative capabilities for a known model family. */
export interface ModelCatalogEntry {
  /** Id glob(s) this entry matches (most-specific entries listed first). */
  readonly patterns: readonly string[];
  /** Reasoning-effort choices the UI should offer; empty = no effort knob. */
  readonly effort: readonly ReasoningEffortChoice[];
  /** Input modalities the model accepts. Overridden by a live `/models` probe. */
  readonly modalities: readonly ModelModality[];
  /** A good lightweight companion model for completion / summarisation. */
  readonly suggestedSmall?: string;
}

/**
 * The catalog. Order matters: the first entry whose glob matches the (lower
 * cased) id wins, so narrower families precede broader ones. Keep this list
 * declarative — no logic, just data — so it reads as a capability sheet.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  // ---- OpenAI ----------------------------------------------------------
  {
    patterns: ["gpt-5*", "o1*", "o3*", "o4*", "codex-*"],
    effort: OPENAI_STYLE,
    modalities: ["text", "image"],
    suggestedSmall: "gpt-4.1-mini",
  },
  {
    patterns: ["gpt-4o*", "gpt-4.1*", "gpt-4-turbo*"],
    effort: NONE,
    modalities: ["text", "image"],
    suggestedSmall: "gpt-4o-mini",
  },
  {
    patterns: ["gpt-4*", "gpt-3*"],
    effort: NONE,
    modalities: ["text"],
    suggestedSmall: "gpt-4o-mini",
  },
  // ---- Anthropic -------------------------------------------------------
  {
    patterns: ["*opus*", "*sonnet*"],
    effort: ALL_WITH_OFF,
    modalities: ["text", "image"],
    suggestedSmall: "claude-haiku-4-5",
  },
  {
    patterns: ["*haiku*"],
    effort: NONE,
    modalities: ["text", "image"],
    suggestedSmall: "claude-haiku-4-5",
  },
  // ---- DeepSeek --------------------------------------------------------
  {
    patterns: ["deepseek-r*", "*reasoner*"],
    effort: OPENAI_STYLE,
    modalities: ["text"],
    suggestedSmall: "deepseek-chat",
  },
  {
    patterns: ["deepseek*"],
    effort: NONE,
    modalities: ["text"],
    suggestedSmall: "deepseek-chat",
  },
  // ---- Google Gemini ---------------------------------------------------
  {
    patterns: ["gemini-2.5*", "gemini-2-5*", "*gemini*thinking*"],
    effort: ALL_WITH_OFF,
    modalities: ["text", "image", "audio", "video"],
    suggestedSmall: "gemini-2.5-flash",
  },
  {
    patterns: ["gemini*"],
    effort: NONE,
    modalities: ["text", "image", "audio", "video"],
    suggestedSmall: "gemini-2.5-flash",
  },
  // ---- GLM (Zhipu / Z.ai) ---------------------------------------------
  {
    patterns: ["glm-z*", "glm-zero*"],
    effort: OPENAI_STYLE,
    modalities: ["text"],
  },
  {
    patterns: ["glm*"],
    effort: NONE,
    modalities: ["text"],
  },
  // ---- Kimi (Moonshot) -------------------------------------------------
  {
    patterns: ["kimi*", "moonshot*"],
    effort: NONE,
    modalities: ["text"],
  },
];

/** Find the catalog entry whose glob first matches `model`, or undefined. */
export function lookupModelCatalog(model: string | undefined): ModelCatalogEntry | undefined {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return undefined;
  for (const entry of MODEL_CATALOG) {
    if (entry.patterns.some((p) => modelGlobMatch(p, id))) return entry;
  }
  return undefined;
}

/** Declared reasoning-effort choices for a known model, else undefined
 * (caller falls back to its id heuristic). */
export function catalogEffortChoices(model: string): readonly ReasoningEffortChoice[] | undefined {
  return lookupModelCatalog(model)?.effort;
}

/** Declared input modalities for a known model, else undefined. */
export function catalogModalities(model: string): readonly ModelModality[] | undefined {
  return lookupModelCatalog(model)?.modalities;
}

/** The suggested small/companion model for a known model, else undefined. */
export function catalogSuggestedSmall(model: string): string | undefined {
  return lookupModelCatalog(model)?.suggestedSmall;
}
