package io.codepilot.harness.context

import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.CompactionApplied
import io.codepilot.harness.event.HarnessEvent
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.event.UserMessageAdded
import io.codepilot.harness.model.ChatMessage
import io.codepilot.harness.model.ChatModel
import io.codepilot.harness.model.ChatRequest
import io.codepilot.harness.model.ModelEvent
import io.codepilot.harness.model.StopKind
import io.codepilot.harness.model.StopReason
import io.codepilot.harness.model.TextDelta
import io.codepilot.harness.model.ToolSchema
import io.codepilot.harness.session.EventSourcedSession
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList

/**
 * Compacts the oldest tail of an event log into a single summary message,
 * keeping the most recent [keepRecent] events verbatim.
 *
 * The summary is produced by asking a [ChatModel] to summarize the dropped tail.
 * The [CompactionApplied] event is then appended to the session so the timeline
 * reflects the compaction. The harness loop calls [maybeCompact] when the
 * token budget is exceeded.
 */
class Compactor(
    private val model: ChatModel,
    private val keepRecent: Int = 20,
) {
    /**
     * If the session has more than [keepRecent] chat events, summarize the tail
     * and append a [CompactionApplied] event. Returns the compaction event, or
     * null if no compaction was needed.
     */
    suspend fun maybeCompact(session: EventSourcedSession, tools: List<ToolSchema> = emptyList()): CompactionApplied? {
        val chatEvents = session.events().filter { EventTypes.isChatEvent(it) }
        if (chatEvents.size <= keepRecent) return null

        val dropped = chatEvents.dropLast(keepRecent)
        val summary = summarize(dropped)
        val compacted = CompactionApplied(
            summary = summary,
            droppedMessages = dropped.size,
        )
        session.append(compacted)
        return compacted
    }

    /**
     * Produce a textual summary of [events] by replaying them as chat messages and
     * asking the model to summarize. Falls back to a deterministic summary if the
     * model errors out (we must never block the loop on a summarization failure).
     */
    private suspend fun summarize(events: List<HarnessEvent>): String {
        val transcript = events.joinToString("\n") { e ->
            when (val m = EventTypes.toChatMessage(e)) {
                is ChatMessage -> "${m.role.name.lowercase()}: ${m.text.take(800)}"
                null -> ""
            }
        }.ifBlank { return "[no prior content]" }

        val req = ChatRequest(
            system = "Summarize the following conversation tail in <= 600 chars. " +
                "Preserve file names, decisions, and pending tasks. Do not narrate.",
            messages = listOf(ChatMessage(ChatMessage.Role.USER, transcript)),
            tools = emptyList(),
            toolSchemas = emptyList(),
            temperature = 0.0,
            maxTokens = 400,
        )
        return try {
            val events = model.stream(req).toList()
            val text = events.filterIsInstance<TextDelta>().joinToString("") { it.text }
            val stopped = events.filterIsInstance<StopReason>().firstOrNull()
            if (text.isBlank() || stopped?.kind == StopKind.ERROR) fallbackSummary(transcript) else text
        } catch (_: Exception) {
            fallbackSummary(transcript)
        }
    }

    private fun fallbackSummary(transcript: String): String {
        val clipped = transcript.take(500)
        return "[compaction fallback: $clipped]"
    }
}

/** Helpers to classify chat-bearing events shared with [HistorySection]. */
private object EventTypes {
    fun isChatEvent(e: HarnessEvent): Boolean = e is UserMessageAdded ||
        e is AssistantMessageAdded ||
        e is ToolResultAdded

    fun toChatMessage(e: HarnessEvent): ChatMessage? = io.codepilot.harness.event.EventTypes.toChatMessage(e)
}
