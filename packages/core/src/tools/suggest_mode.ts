// suggest_mode: let the model propose switching the collaboration mode
// (chat / plan / agent) when it judges the current task would be better served
// in a different mode — then let the USER decide.
//
// Why a tool, not a heuristic
// ---------------------------
// Auto-switching mode by guessing "task complexity" (step count, file count,
// keywords) is a scenario-specific heuristic that misfires. Instead the MODEL
// — which actually understands the request — proposes a switch via its own
// semantic judgement, and the user confirms. This mirrors how Cursor surfaces
// Plan mode (suggest → user accepts/clicks Build), not a silent auto-switch.
//
// Behaviour
// ---------
//  - Headless or `autoAcceptModeSuggestions` on → accept silently and switch.
//  - Otherwise ask the user (ask_user channel). Accept → switch; decline → stay.
// Acceptance reuses the existing `mode_request` → setAgentMode flow (the same
// path plan_done uses), so no new switching machinery is introduced. The tool
// result carries a `mode_request` block the agent loop already understands.

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
    "Propose switching the collaboration mode (chat/plan/agent) when the task would be better " +
    "served in another mode — e.g. suggest 'plan' before a large multi-step change so you design " +
    "first, or 'agent' once a plan is ready to execute. The USER confirms the switch (unless they " +
    "opted into auto-accept). Use sparingly, only at a genuine inflection point; do not toggle modes " +
    "every turn. If you are already in the right mode, do not call this.",
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
            { label: "Always switch", description: "Switch, and auto-accept future mode suggestions this session." },
            { label: "Stay", description: "Keep the current mode." },
          ],
        },
      ],
    });
    const raw = answers["switch"];
    const answer = Array.isArray(raw) ? raw[0] : raw;
    if (answer === "Switch" || answer === "Always switch") {
      return makeResult(input.mode, input.reason, true, answer === "Always switch");
    }
    return {
      content: `Mode suggestion declined — staying in ${current ?? "the current"} mode. Continue the task as-is.`,
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
