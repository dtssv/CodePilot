// Background permission classifier for the `auto` mode: adjudicates tool calls
// not covered by an explicit rule and not tripping a hard safety floor, as
// "allow" / "deny" (with a model-visible reason) / "uncertain" (prompt). It can
// never override a hard floor; the caller falls back to the human after too many
// denials, so a misfiring classifier cannot wedge the hot path.

import type { ToolDef } from "./tools/types.js";

/** A single call presented to the classifier. Deliberately small and
 * structured — the program/primary argument, the tool's permission tier, the
 * cwd, and a short diff/summary when one is cheaply available. */
export interface PermissionClassificationInput {
  toolName: string;
  /** read | write | network | (none). The permission tier of the tool. */
  permission: string;
  /** The tool's primary argument (command / path / url / query), if any. */
  primary?: string;
  cwd: string;
  /** A short human-readable summary of the effect (e.g. a file list for a
   * patch, or the reason string the engine built). Bounded by the caller. */
  summary?: string;
}

export type PermissionClassification =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "uncertain" };

/** Adjudicates a soft (non-floor) permission ask. Implementations must fail
 * safe: any error should surface as `uncertain` so the caller falls back to a
 * prompt rather than silently allowing. */
export interface PermissionClassifier {
  classify(
    input: PermissionClassificationInput,
    signal?: AbortSignal,
  ): Promise<PermissionClassification>;
}

/** Build the structured input a classifier sees from a tool call. `primary` and
 * `summary` are already extracted/bounded by the engine. */
export function buildClassificationInput(
  tool: ToolDef,
  primary: string | undefined,
  cwd: string,
  summary?: string,
): PermissionClassificationInput {
  return {
    toolName: tool.name,
    permission: tool.permission ?? "none",
    ...(primary ? { primary: primary.slice(0, 2_000) } : {}),
    cwd,
    ...(summary ? { summary: summary.slice(0, 2_000) } : {}),
  };
}

/** Fixed safety policy handed to the small-model classifier. It never sees a
 * hard-floor call (those are decided before it runs), so its job is to separate
 * ordinary benign work from the merely-risky middle ground. */
export const CLASSIFIER_POLICY = `You are a permission gate for a coding agent. Decide whether a single tool call may run WITHOUT asking the human. You are only consulted for calls that already passed the hard safety floors (no dangerous command, no write to a system/credential path or .git, no sandbox escalation, no write outside the workspace), so your job is to catch the merely-risky middle ground.

Allow when the call is ordinary development work: reading or editing project files inside the workspace, running build/test/lint/format/VCS-status commands, searching, fetching documentation.

Deny (with a one-sentence reason the agent should act on) when the call would do something a careful human would want to stop even though it is not a hard floor — for example: deleting large or unrelated trees, publishing/deploying/pushing, mutating global or machine state, touching another project outside the workspace, exfiltrating data, or anything whose effect is clearly disproportionate to an ordinary coding task.

Answer "uncertain" when you genuinely cannot tell from the given information whether it is safe; the human will be asked.

Respond with JSON only — no markdown:
{"decision":"allow"}
or
{"decision":"deny","reason":"one short sentence"}
or
{"decision":"uncertain"}`;

/** A small-model-backed classifier. `ask` is the same prompt resolver the Stop
 * verifier uses (system policy + JSON payload → raw JSON string); supplying it
 * here keeps the classifier free of any direct provider dependency and reuses
 * the session's small-model wiring. Any failure maps to `uncertain`. */
export function createPromptPermissionClassifier(
  ask: (policy: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<string>,
): PermissionClassifier {
  return {
    async classify(input, signal) {
      try {
        const raw = await ask(CLASSIFIER_POLICY, input as unknown as Record<string, unknown>, signal);
        return parseClassification(raw);
      } catch {
        // Fail safe: an unreachable/slow/erroring classifier must hand control
        // back to the human, never silently allow.
        return { decision: "uncertain" };
      }
    },
  };
}

/** Parse the classifier's JSON reply, tolerating markdown fences and stray
 * prose. Anything unrecognised → uncertain (fall back to a prompt). */
export function parseClassification(raw: string): PermissionClassification {
  const text = raw.trim();
  // Pull the first {...} object out of the reply (handles ```json fences).
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { decision: "uncertain" };
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return { decision: "uncertain" };
  }
  if (!obj || typeof obj !== "object") return { decision: "uncertain" };
  const decision = (obj as { decision?: unknown }).decision;
  if (decision === "allow") return { decision: "allow" };
  if (decision === "deny") {
    const reason = (obj as { reason?: unknown }).reason;
    return {
      decision: "deny",
      reason:
        typeof reason === "string" && reason.trim()
          ? reason.trim()
          : "the classifier refused this call",
    };
  }
  return { decision: "uncertain" };
}
