package io.codepilot.harness

import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.RunFinished
import io.codepilot.harness.event.RunStarted
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.event.UserMessageAdded
import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.session.SessionStore
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class SessionReplayAndCodecTest {

    @TempDir
    lateinit var dir: Path

    @Test
    fun `codec roundtrips every event type with type discriminator`() {
        val json = Json { encodeDefaults = true; classDiscriminator = "t" }
        val events = listOf(
            RunStarted(sessionId = "s1", goal = "g"),
            UserMessageAdded(text = "hi"),
            AssistantMessageAdded(text = "doing", toolCalls = listOf(ToolCallSpec("c1", "read_file", "{}"))),
            ToolResultAdded(callId = "c1", tool = "read_file", ok = true, output = "..."),
            RunFinished(status = RunFinished.COMPLETED, totalSteps = 2),
        )
        for (e in events) {
            val line = json.encodeToString(io.codepilot.harness.event.HarnessEvent.serializer(), e)
            assertTrue(line.contains("\"t\":\""), "discriminator missing: $line")
            assertTrue(line.contains("\"seq\":"), "seq missing: $line")
            val back = json.decodeFromString(io.codepilot.harness.event.HarnessEvent.serializer(), line)
            assertEquals(back, e)
        }
    }

    @Test
    fun `store append persists fsync-safe and reloads`() {
        val store = SessionStore(dir.resolve("events.jsonl"))
        store.append(UserMessageAdded(text = "one"))
        store.append(AssistantMessageAdded(text = "two"))
        store.append(RunFinished(status = RunFinished.COMPLETED, totalSteps = 1))
        val reopened = SessionStore(dir.resolve("events.jsonl"))
        val all = reopened.readAll()
        assertEquals(listOf("one"), all.filterIsInstance<UserMessageAdded>().map { it.text })
        assertEquals(3, all.size)
        assertEquals(setOf(0L, 1L, 2L), all.map { it.seq }.toSet())
    }

    @Test
    fun `truncateAfter rewinds log and nextSeq continues`() {
        val store = SessionStore(dir.resolve("events.jsonl"))
        repeat(5) { store.append(UserMessageAdded(text = "m$it")) }
        val removed = store.truncateAfter(3)
        assertEquals(2, removed.size)
        assertEquals(3, store.readAll().size)
        store.append(UserMessageAdded(text = "after"))
        val seqs = store.readAll().map { it.seq }
        assertEquals(listOf(0L, 1L, 2L, 3L), seqs)
    }
}
