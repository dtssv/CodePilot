package io.codepilot.harness.testfix

import io.codepilot.harness.model.AssistantToolCall
import io.codepilot.harness.model.ChatModel
import io.codepilot.harness.model.ChatRequest
import io.codepilot.harness.model.ModelEvent
import io.codepilot.harness.model.StopKind
import io.codepilot.harness.model.StopReason
import io.codepilot.harness.model.TextDelta
import io.codepilot.harness.model.ScriptedTurn
import io.codepilot.harness.model.UsageReport
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow



class FakeChatModel(private val turns: List<ScriptedTurn>) : ChatModel {
    override val name = "fake"
    private var index = 0
    val requestsSeen = mutableListOf<ChatRequest>()

    constructor(vararg turns: ScriptedTurn) : this(turns.toList())

    override fun stream(request: ChatRequest): Flow<ModelEvent> = flow {
        requestsSeen.add(request)
        if (index >= turns.size) {
            emit(StopReason(StopKind.ERROR, "FakeChatModel exhausted at turn $index"))
            return@flow
        }
        val turn = turns[index++]
        turn.fail?.let {
            emit(StopReason(StopKind.ERROR, it))
            return@flow
        }
        turn.text?.let { t ->
            t.chunked(7).forEach { emit(TextDelta(it)) }
        }
        turn.toolCalls.forEach { emit(it) }
        emit(StopReason(turn.stop))
        emit(UsageReport(turn.usage.first, turn.usage.second))
    }
}
