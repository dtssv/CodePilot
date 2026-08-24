package io.codepilot.harness.hooks

import io.codepilot.harness.event.HarnessEvent
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.session.EventSourcedSession
import io.codepilot.harness.tool.ToolCatalog
import io.codepilot.harness.tool.ToolOutput

/**
 * Pre-tool-use hook: invoked before a tool runs.
 * - Return null to keep the call unchanged.
 * - Return a non-null ToolCallSpec (e.g. with rewritten argumentsJson) to rewrite the call.
 * - Throw [HookVeto] to veto the call; the result will be recorded as denied with the given reason.
 */
interface PreToolUseHook {
    suspend fun intercept(call: ToolCallSpec, catalog: ToolCatalog): ToolCallSpec?
}

/** Thrown by a [PreToolUseHook] to veto execution. */
class HookVeto(val reason: String) : RuntimeException(reason)

/**
 * Post-tool-use hook: invoked after a tool runs, before the result is persisted.
 * May return a rewritten [ToolOutput] (e.g. to inject format/lint findings) or the original.
 */
interface PostToolUseHook {
    suspend fun after(call: ToolCallSpec, out: ToolOutput): ToolOutput
}

/**
 * Stop hook: invoked when the model emits end_turn or max_steps is reached.
 * Lets a hook veto stopping (return [StopDirective.Continue]) to force another turn,
 * e.g. to run a build validator and feed errors back.
 */
interface StopHook {
    suspend fun onStop(session: EventSourcedSession): StopDirective
}

/** What to do after a stop hook runs. */
sealed interface StopDirective {
    /** Stop the run now. */
    data object Stop : StopDirective
    /** Force another turn; [reason] is appended to the context as a user/tool message. */
    data class Continue(val reason: String) : StopDirective
}

/**
 * Coordinates pre/post/stop hooks around the harness tool loop.
 *
 * Design: hooks are plain lists, executed in order; first veto/rewrite/continue wins.
 * The harness invokes [pre] before each tool call, [post] after, and [onStop] when
 * the model signals end_turn (or max_steps).
 */
class HookRunner(
    val pre: List<PreToolUseHook> = emptyList(),
    val post: List<PostToolUseHook> = emptyList(),
    val stop: List<StopHook> = emptyList(),
) {
    /**
     * Run pre-hooks. Returns:
     * - the (possibly rewritten) ToolCallSpec to execute, or
     * - null to veto (caller records a denied ToolResultAdded).
     */
    suspend fun pre(call: ToolCallSpec, catalog: ToolCatalog): PreResult {
        var current: ToolCallSpec? = call
        for (hook in pre) {
            val c = current ?: return PreResult.Veto("vetoed by ${hook::class.simpleName}")
            try {
                val rewritten = hook.intercept(c, catalog)
                current = rewritten ?: c
            } catch (e: HookVeto) {
                return PreResult.Veto(e.reason)
            } catch (e: Exception) {
                return PreResult.Veto("hook ${hook::class.simpleName} threw: ${e.message}")
            }
        }
        return current?.let { PreResult.Proceed(it) } ?: PreResult.Veto("vetoed")
    }

    /** Run post-hooks. Returns the (possibly rewritten) ToolOutput. */
    suspend fun post(call: ToolCallSpec, out: ToolOutput): ToolOutput {
        var current = out
        for (hook in post) {
            current = try {
                hook.after(call, current)
            } catch (_: Exception) {
                current
            }
        }
        return current
    }

    /** Run stop-hooks. First [StopDirective.Continue] wins; otherwise Stop. */
    suspend fun onStop(session: EventSourcedSession): StopDirective {
        for (hook in stop) {
            try {
                val d = hook.onStop(session)
                if (d is StopDirective.Continue) return d
            } catch (_: Exception) {
                // ignore failing stop hooks
            }
        }
        return StopDirective.Stop
    }
}

sealed interface PreResult {
    data class Proceed(val call: ToolCallSpec) : PreResult
    data class Veto(val reason: String) : PreResult
}
