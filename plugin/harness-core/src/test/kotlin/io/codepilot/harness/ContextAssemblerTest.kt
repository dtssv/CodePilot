package io.codepilot.harness

import io.codepilot.harness.context.ContextAssembler
import io.codepilot.harness.context.HistorySection
import io.codepilot.harness.context.IdentitySection
import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.UserMessageAdded
import io.codepilot.harness.session.EventSourcedSession
import io.codepilot.harness.session.SessionStore
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class ContextAssemblerTest {

    @TempDir
    lateinit var dir: Path

    @Test
    fun `sections compose into system prompt in order with budgets`() {
        val store = SessionStore(dir.resolve("e.jsonl"))
        val session = EventSourcedSession(store)
        session.append(UserMessageAdded(text = "hi"))
        session.append(AssistantMessageAdded(text = "hello"))
        val assembler = ContextAssembler(
            sections = listOf(IdentitySection("You are CodePilot.")),
            history = HistorySection(keepRecent = 10),
        )
        val req = assembler.assemble(session, tools = emptyList())
        assertTrue(req.system.contains("You are CodePilot."))
        assertEquals(2, req.messages.size)
        assertTrue(req.system.indexOf("## identity") >= 0)
    }

    @Test
    fun `history section compacts old messages beyond keepRecent`() {
        val store = SessionStore(dir.resolve("e.jsonl"))
        val session = EventSourcedSession(store)
        repeat(30) { i ->
            session.append(UserMessageAdded(text = "u$i"))
            session.append(AssistantMessageAdded(text = "a$i"))
        }
        val history = HistorySection(keepRecent = 20)
        val msgs = history.toMessages(session.events())
        assertEquals(21, msgs.size)
        assertTrue(msgs.first().text.startsWith("[earlier history compacted"))
    }
}
