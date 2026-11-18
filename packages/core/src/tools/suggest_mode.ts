// suggest_mode: let the model propose switching collaboration mode
// (chat/plan/agent); the user decides. Headless or autoAcceptModeSuggestions
// → accept silently; otherwise ask via ask_user (accept / always-switch /
// decline). Reuses the existing `mode_request` → setAgentMode flow.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const schema = z.object({
  mode: z
    .enum(["chat", "plan", "agent"])
    .describe(
      "The mode you propose switching to: 'plan' to design before acting, " +
        "'agent' to execute autonomously, 'chat' for answers without edits.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence on WHY this mode fits the task better right now " +
        "(shown to the user in the confirmation).",
    ),
});

export interface SuggestModeTool extends ToolDef<typeof schema> {
  /** Wired by the session: current collaboration mode (skip no-op suggestions). */
  currentMode?: () => "chat" | "plan" | "agent";
  /** Wired by the session: whether the user opted into auto-accepting. */
  autoAccept?: () => boolean;
}

export const suggestModeTool: SuggestModeTool = {
  name: "suggest_mode",
  description:
    "Propose switching collaboration mode (chat|plan|agent). User confirms unless " +
    "auto-accept is on. Call only at a real inflection; skip if already in the right mode. " +
    "If the user declines a switch, do not re-propose that same target until they ask.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const current = (this as SuggestModeTool).currentMode?.();
    if (current && current === input.mode) {
      return { content: `Already in ${input.mode} mode; no switch needed.` };
    }

    const autoAccept = (this as SuggestModeTool).autoAccept?.() ?? false;
    const accept = (): ReturnType<typeof makeResult> =>
      makeResult(input.mode, input.reason, true);

    // Auto-accept (user opted in) or headless (no ask channel) → switch now.
    if (autoAccept || !ctx.askUser) {
      return accept();
    }

    const answers = await ctx.askUser({
      requestId: `mode_${Math.random().toString(36).slice(2, 10)}`,
      questions: [
        {
          id: "switch",
          header: "Switch mode?",
          question:
            `Switch to **${input.mode}** mode?\n\n${input.reason}`,
          options: [
            { label: "Switch", description: `Change to ${input.mode} mode.` },
            { label: "Always switch", description: "Switch, and auto-accept future mode suggestions (saved to your config)." },
            { label: "Stay", description: "Keep the current mode (type your own note to steer instead)." },
          ],
        },
      ],
    });
    const raw = answers["switch"];
    const answer = Array.isArray(raw) ? raw[0] : raw;
    if (answer === "Switch" || answer === "Always switch") {
      return makeResult(input.mode, input.reason, true, answer === "Always switch");
    }
    // Decline. Anything other than the exact "Switch"/"Always switch" labels —
    // including free text the user typed instead of picking "Stay" — keeps the
    // current mode. Free-text (a correction) rides into the tool result so the
    // model sees the instruction rather than a bare "declined".
    const correction = answer && answer !== "Stay" ? answer.trim() : "";
    const base = `Mode suggestion declined — staying in ${current ?? "the current"} mode.`;
    return {
      content: correction
        ? `${base} The user said: ${correction}`
        : `${base} Continue the task as-is.`,
    };
  },
};

function makeResult(
  mode: "chat" | "plan" | "agent",
  reason: string,
  approved: boolean,
  rememberAuto = false,
): { content: string; blocks: Array<{ type: "text"; text: string }> } {
  return {
    content: approved
      ? `Switched to ${mode} mode (${reason}). Continue the task in ${mode} mode.`
      : `Staying in the current mode.`,
    blocks: [
      {
        type: "text",
        // The agent loop parses this into a `mode_request` event (same channel
        // plan_done uses). `rememberAuto` tells the session to persist the
        // auto-accept preference.
        text: JSON.stringify({ type: "mode_request", mode, reason, rememberAuto }),
      },
    ],
  };
}
