package io.codepilot.harness.session

import io.codepilot.harness.event.EventTypes
import io.codepilot.harness.event.HarnessEvent
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.event.UserMessageAdded

/** In-memory projection over the event log. Rebuilt by replay; never a second source of truth. */
class EventSourcedSession(val store: SessionStore) {

    private val cache = mutableListOf<HarnessEvent>()

    fun replayAll() {
        cache.clear()
        cache.addAll(store.readAll())
    }

    init {
        replayAll()
    }

    fun append(event: HarnessEvent): HarnessEvent {
        val stored = store.append(event)
        cache.add(stored)
        return stored
    }

    fun events(): List<HarnessEvent> = cache.toList()

    /** Chat transcript rebuilt from events (compaction-aware callers filter first). */
    fun chatTranscript(): List<Pair<HarnessEvent, io.codepilot.harness.model.ChatMessage>> =
        cache.mapNotNull { e -> EventTypes.toChatMessage(e)?.let { e to it } }

    fun rewindTo(seqExclusive: Long) {
        store.truncateAfter(seqExclusive)
        replayAll()
    }

    companion object {
        fun createFresh(store: SessionStore, sessionId: String, goal: String): EventSourcedSession {
            val s = EventSourcedSession(store)
            s.append(io.codepilot.harness.event.RunStarted(sessionId = sessionId, goal = goal))
            s.append(UserMessageAdded(text = goal))
            return s
        }
    }
}
