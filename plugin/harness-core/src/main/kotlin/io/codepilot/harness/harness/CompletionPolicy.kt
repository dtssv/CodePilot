package io.codepilot.harness.harness

import io.codepilot.harness.context.Compactor
import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.HarnessEvent
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.hooks.HookRunner
import io.codepilot.harness.hooks.StopDirective
import io.codepilot.harness.model.ChatMessage
import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.session.EventSourcedSession
import io.codepilot.harness.tool.ToolOutput

/**
 * Decides whether the harness should actually stop after a model end_turn or
 * after hitting max_steps.
 *
 * Solves P2-10: "Agent 自以为完成但编译不过". stop_reason == end_turn is NOT
 * task completion. This policy runs:
 *   1. PostToolUse hooks (format/lint) when the turn produced edits;
 *   2. The first StopDirective.Continue forces another turn with the
 *      hook's reason appended to context (e.g. build errors).
 *
 * In `strict` mode, the policy is authoritative: even if the model says
 * end_turn, a failing stop hook keeps the run alive. In `off` mode it's a
 * pass-through (always Stop).
 */
class CompletionPolicy(
    private val hooks: HookRunner = HookRunner(),
    private val compactor: Compactor? = null,
    private val strict: Boolean = false,
) {
    /**
     * Called by the harness when the model emits end_turn (no pending tool calls)
     * or after executing the turn's pending tool calls.
     *
     * Returns:
     * - [StopDirective.Stop] to terminate the run (or let the loop continue to
     *   the next model turn);
     * - [StopDirective.Continue] with a reason to inject as a follow-up user
     *   message, forcing the model to address the failure (e.g. build errors).
     *
     * In non-strict mode (default), this always returns Stop — preserving
     * the legacy deterministic behavior so existing scripted tests pass.
     *
     * @param hadEdits whether the current turn produced any write/exec tool calls.
     */
    suspend fun afterTurn(session: EventSourcedSession, hadEdits: Boolean): StopDirective {
        if (!strict) return StopDirective.Stop

        val stopDirective = hooks.onStop(session)
        if (stopDirective is StopDirective.Continue) return stopDirective

        // Optional compaction: if the session grew large, compact now so the
        // next turn (if any) starts with a smaller context.
        compactor?.maybeCompact(session)

        return StopDirective.Stop
    }

    /**
     * Run post-tool hooks for the tool results of the current turn.
     * Returns the (possibly rewritten) outputs in the same order.
     */
    suspend fun postToolResults(
        calls: List<ToolCallSpec>,
        outputs: List<ToolOutput>,
    ): List<ToolOutput> {
        if (calls.size != outputs.size) return outputs
        return calls.zip(outputs).map { (call, out) -> hooks.post(call, out) }
    }
}
