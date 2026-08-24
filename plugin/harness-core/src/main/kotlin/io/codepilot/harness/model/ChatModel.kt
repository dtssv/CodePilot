package io.codepilot.harness.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ChatMessage(
    val role: Role,
    val text: String = "",
    @SerialName("tool_calls") val toolCalls: List<ToolCallSpec> = emptyList(),
    @SerialName("tool_call_id") val toolCallId: String? = null,
) {
    @Serializable
    enum class Role { SYSTEM, USER, ASSISTANT, TOOL }
}

@Serializable
data class ToolCallSpec(val id: String, val name: String, val argumentsJson: String)

@Serializable
data class ChatRequest(
    val system: String,
    val messages: List<ChatMessage>,
    val tools: List<ToolCallSpec> = emptyList(),
    val toolSchemas: List<ToolSchema> = emptyList(),
    val temperature: Double = 0.2,
    @SerialName("max_tokens") val maxTokens: Int? = null,
)

@Serializable
data class ToolSchema(val name: String, val description: String, @SerialName("parameters_json") val parametersJson: String)

sealed interface ModelEvent

@Serializable
data class TextDelta(val text: String) : ModelEvent

@Serializable
data class AssistantToolCall(
    @SerialName("call_id") val callId: String,
    val name: String,
    @SerialName("arguments_json") val argumentsJson: String,
) : ModelEvent

enum class StopKind { END_TURN, TOOL_USE, MAX_TOKENS, ERROR }

@Serializable
data class StopReason(val kind: StopKind, val detail: String? = null) : ModelEvent

@Serializable
data class UsageReport(@SerialName("input_tokens") val inputTokens: Long, @SerialName("output_tokens") val outputTokens: Long) : ModelEvent

interface ChatModel {
    val name: String
    fun stream(request: ChatRequest): kotlinx.coroutines.flow.Flow<ModelEvent>
}
