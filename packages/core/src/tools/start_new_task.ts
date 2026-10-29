// start_new_task: let the model draw a task boundary — archive the current
// working context and continue with a clean slate.
//
// This is a GENERIC capability, not a scenario-specific heuristic. The model
// calls it only when it judges that the current task is finished AND the next
// request is unrelated to it, so carrying the full prior transcript forward
// would waste context and risk cross-task contamination (e.g. reasoning about
// task B while still "remembering" the details of task A). Nothing auto-fires:
// the model decides, exactly as a user would with `/clear`.
//
// The session wires `onStartNewTask` to Session.clearWorkingContext, which
// force-summarises the prior context (full transcript retained on disk) and
// injects a boundary marker. If no handle is wired (tests / minimal hosts),
// the tool degrades to a no-op acknowledgement.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const schema = z.object({
  reason: z
    .string()
    .optional()
    .describe(
      "One short line on why the current task is complete and the next is " +
        "unrelated (e.g. 'finished the auth refactor; next request is about docs'). " +
        "Recorded on the boundary for the transcript.",
    ),
});

export interface StartNewTaskHandle {
  /** Archive current context; returns true if a boundary was actually drawn. */
  (reason?: string): Promise<boolean>;
}

export interface StartNewTaskTool extends ToolDef<typeof schema> {
  /** Wired by the session to Session.clearWorkingContext. */
  onStartNewTask?: StartNewTaskHandle;
}

export const startNewTaskTool: StartNewTaskTool = {
  name: "start_new_task",
  description:
    "Draw a task boundary: archive the current conversation context and continue with a clean " +
    "slate, when the current task is DONE and the next request is UNRELATED to it. Use this to " +
    "avoid carrying a finished task's details into a new one (which wastes context and can cause " +
    "you to conflate the two). The prior work is summarised and kept on disk — you can still " +
    "reference it — but it stops being active context. Do NOT use it mid-task, or when the next " +
    "step builds on what you just did; only at a genuine boundary between independent tasks. " +
    "When unsure, don't call it.",
  inputSchema: schema,
  permission: "read",
  async execute(input, _ctx) {
    // Read from `this`: the session registers a per-session COPY with its own
    // `onStartNewTask` wired, and the registry invokes `tool.execute(...)` so
    // `this` is that copy. (Reading the module singleton would miss the wiring.)
    const handle = (this as StartNewTaskTool).onStartNewTask;
    if (!handle) {
      return {
        content:
          "start_new_task is not available in this host; continue in the current context.",
      };
    }
    const cleared = await handle(input.reason);
    return {
      content: cleared
        ? "Context archived. The previous task's transcript is retained on disk for reference; " +
          "this is now a clean slate. Proceed with the next task from the user's latest message."
        : "Nothing to archive yet (no prior task context). Continue normally.",
    };
  },
};
