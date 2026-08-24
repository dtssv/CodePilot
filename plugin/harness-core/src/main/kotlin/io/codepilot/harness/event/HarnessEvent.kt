package io.codepilot.harness.event

import io.codepilot.harness.model.ChatMessage
import io.codepilot.harness.model.ToolCallSpec
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed interface HarnessEvent {
    val seq: Long
    val ts: Long
}

@Serializable
data class RunStarted(
    override val seq: Long = -1,
    override val ts: Long = now(),
    @SerialName("session_id") val sessionId: String,
    val goal: String,
) : HarnessEvent

@Serializable
data class UserMessageAdded(
    override val seq: Long = -1,
    override val ts: Long = now(),
    val text: String,
) : HarnessEvent

@Serializable
data class AssistantMessageAdded(
    override val seq: Long = -1,
    override val ts: Long = now(),
    val text: String,
    @SerialName("tool_calls") val toolCalls: List<ToolCallSpec> = emptyList(),
) : HarnessEvent

@Serializable
data class ToolResultAdded(
    override val seq: Long = -1,
    override val ts: Long = now(),
    @SerialName("call_id") val callId: String,
    val tool: String,
    val ok: Boolean,
    val output: String,
    val truncated: Boolean = false,
) : HarnessEvent

@Serializable
data class PermissionDecisionRecorded(
    override val seq: Long = -1,
    override val ts: Long = now(),
    @SerialName("call_id") val callId: String,
    val tool: String,
    val verdict: String,
    val reason: String? = null,
) : HarnessEvent

@Serializable
data class CompactionApplied(
    override val seq: Long = -1,
    override val ts: Long = now(),
    val summary: String,
    @SerialName("dropped_messages") val droppedMessages: Int,
) : HarnessEvent

@Serializable
data class RunFinished(
    override val seq: Long = -1,
    override val ts: Long = now(),
    val status: String,
    @SerialName("total_steps") val totalSteps: Int,
    val detail: String? = null,
) : HarnessEvent {
    companion object {
        const val COMPLETED = "completed"
        const val MAX_STEPS = "max_steps_reached"
        const val ERROR = "error"
    }
}

private fun now(): Long = System.currentTimeMillis()

object EventTypes {
    fun toChatMessage(e: HarnessEvent): ChatMessage? = when (e) {
        is UserMessageAdded -> ChatMessage(ChatMessage.Role.USER, text = e.text)
        is AssistantMessageAdded -> ChatMessage(ChatMessage.Role.ASSISTANT, text = e.text, toolCalls = e.toolCalls)
        is ToolResultAdded -> ChatMessage(ChatMessage.Role.TOOL, text = e.output, toolCallId = e.callId)
        else -> null
    }
}
