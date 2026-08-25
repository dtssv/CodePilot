package io.codepilot.adapter

import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.CompactionApplied
import io.codepilot.harness.event.HarnessEvent
import io.codepilot.harness.event.PermissionDecisionRecorded
import io.codepilot.harness.event.RunFinished
import io.codepilot.harness.event.RunStarted
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.event.UserMessageAdded

/**
 * Forwards harness-core [HarnessEvent]s to the plugin-side UI.
 *
 * The harness-core loop emits an append-only NDJSON event log; the plugin's
 * WebUI consumes a UI protocol. This adapter is the one-way bridge: harness
 * event → [dispatch] callback.
 *
 * The [dispatch] callback is injected by the plugin host (typically wiring
 * to `EventBus.emit`). Keeping it as a function type avoids a reverse
 * dependency from ide-adapter back to the plugin main module.
 *
 * Each harness event is mapped to a tuple of (type, payload-map); the host
 * is responsible for allocating seq/turnId/stepId on its side.
 */
class EventBusForwarder(
    private val sessionTurnId: String = "harness",
    private val dispatch: (type: String, payload: Map<String, Any?>) -> Unit,
) {
    fun forward(e: HarnessEvent) {
        when (e) {
            is RunStarted -> dispatch(
                "turn.start",
                mapOf("sessionId" to e.sessionId, "goal" to e.goal, "turnId" to sessionTurnId),
            )
            is UserMessageAdded -> dispatch(
                "user.message",
                mapOf("text" to e.text),
            )
            is AssistantMessageAdded -> dispatch(
                "step.start",
                mapOf("kind" to "llm", "text" to e.text),
            )
            is ToolResultAdded -> dispatch(
                "tool.result",
                mapOf(
                    "callId" to e.callId,
                    "tool" to e.tool,
                    "ok" to e.ok,
                    "output" to e.output,
                    "truncated" to e.truncated,
                ),
            )
            is PermissionDecisionRecorded -> dispatch(
                "permission.decision",
                buildMap {
                    put("callId", e.callId)
                    put("tool", e.tool)
                    put("verdict", e.verdict)
                    if (e.reason != null) put("reason", e.reason)
                },
            )
            is CompactionApplied -> dispatch(
                "context.compacted",
                mapOf("summary" to e.summary, "droppedMessages" to e.droppedMessages),
            )
            is RunFinished -> dispatch(
                "turn.end",
                buildMap {
                    put("turnId", sessionTurnId)
                    put("status", e.status)
                    if (e.detail != null) put("reason", e.detail)
                },
            )
        }
    }
}
