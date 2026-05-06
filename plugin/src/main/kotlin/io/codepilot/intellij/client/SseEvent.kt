package io.codepilot.intellij.client

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonSubTypes
import com.fasterxml.jackson.annotation.JsonTypeInfo

/**
 * SSE events from the CodePilot backend, matching AgentEvent on the server side.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes(
    JsonSubTypes.Type(value = SseEvent.Delta::class, name = "delta"),
    JsonSubTypes.Type(value = SseEvent.Plan::class, name = "plan"),
    JsonSubTypes.Type(value = SseEvent.PlanDelta::class, name = "planDelta"),
    JsonSubTypes.Type(value = SseEvent.Digest::class, name = "digest"),
    JsonSubTypes.Type(value = SseEvent.TaskLedger::class, name = "taskLedger"),
    JsonSubTypes.Type(value = SseEvent.ToolCall::class, name = "toolCall"),
    JsonSubTypes.Type(value = SseEvent.ToolResultAck::class, name = "toolResultAck"),
    JsonSubTypes.Type(value = SseEvent.Patch::class, name = "patch"),
    JsonSubTypes.Type(value = SseEvent.Usage::class, name = "usage"),
    JsonSubTypes.Type(value = SseEvent.Error::class, name = "error"),
    JsonSubTypes.Type(value = SseEvent.Done::class, name = "done")
)
sealed class SseEvent {
    data class Delta(val text: String) : SseEvent()
    data class Plan(val steps: Any?) : SseEvent()
    data class PlanDelta(val delta: Any?) : SseEvent()
    data class Digest(val summary: String?) : SseEvent()
    data class TaskLedger(val goal: String?, val subtasks: List<Any>?) : SseEvent()

    data class ToolCall(
        val id: String,
        val name: String,
        val args: Map<String, Any>?,
        val riskLevel: String?,
        val why: String?
    ) : SseEvent()

    data class ToolResultAck(val toolCallId: String, val status: String) : SseEvent()

    data class Patch(val patches: List<PatchOp>) : SseEvent()

    data class Usage(val inputTokens: Long, val outputTokens: Long) : SseEvent()

    data class Error(val code: Int, val message: String?) : SseEvent()

    data class Done(
        val reason: String?,
        val continuationToken: String?,
        val summary: String?,
        val nextAction: String?
    ) : SseEvent()
}

/** A single patch operation from the backend. */
@JsonInclude(JsonInclude.Include.NON_NULL)
data class PatchOp(
    val path: String,
    val type: String,
    val search: String?,
    val replace: String?,
    val range: RangeSpec?,
    val description: String?
)

data class RangeSpec(val startLine: Int, val endLine: Int)