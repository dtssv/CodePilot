package io.codepilot.harness.model

data class ScriptedTurn(
    val text: String? = null,
    val toolCalls: List<AssistantToolCall> = emptyList(),
    val stop: StopKind = if (toolCalls.isEmpty()) StopKind.END_TURN else StopKind.TOOL_USE,
    val usage: Pair<Long, Long> = 100L to 50L,
    val fail: String? = null,
)
