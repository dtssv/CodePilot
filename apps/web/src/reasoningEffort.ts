/**
 * Re-export core reasoning-effort helpers (version-agnostic id heuristics +
 * optional per-model `reasoningEffortChoices` override). The `./reasoning`
 * subpath is browser-safe (no native Node addons in its import graph).
 */

export {
  reasoningEffortChoicesForModel,
  reasoningEffortFromChoice,
  reasoningEffortToChoice,
  supportsReasoningEffort,
} from "@codepilot/core/reasoning";
export type {
  ReasoningEffort,
  ReasoningEffortCaps,
  ReasoningEffortChoice,
} from "@codepilot/core/reasoning";
