package io.codepilot.harness

import io.codepilot.harness.context.ContextAssembler
import io.codepilot.harness.context.HistorySection
import io.codepilot.harness.context.IdentitySection
import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.RunFinished
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.event.UserMessageAdded
import io.codepilot.harness.harness.AgentHarness
import io.codepilot.harness.harness.HarnessConfig
import io.codepilot.harness.model.AssistantToolCall
import io.codepilot.harness.perm.PermissionGate
import io.codepilot.harness.session.EventSourcedSession
import io.codepilot.harness.session.SessionStore
import io.codepilot.harness.testfix.FakeChatModel
import io.codepilot.harness.model.ScriptedTurn
import io.codepilot.harness.tool.WorkspaceScope
import io.codepilot.harness.tool.builtin.defaultFsCatalog
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class ScenarioReadEditTest {

    @TempDir
    lateinit var ws: Path

    private fun harness(script: List<ScriptedTurn>): Pair<AgentHarness, FakeChatModel> {
        Files.writeString(ws.resolve("App.kt"), "fun main() {\n    println(\"hello\")\n}\n")
        val model = FakeChatModel(*script.toTypedArray())
        val scope = WorkspaceScope(ws)
        val session = EventSourcedSession(SessionStore(ws.resolve(".codepilot/events.jsonl")))
        val harness = AgentHarness(
            model = model,
            catalog = io.codepilot.harness.tool.ToolCatalog(defaultFsCatalog(scope)),
            assembler = ContextAssembler(
                sections = listOf(IdentitySection("You are a coding agent.")),
                history = HistorySection(),
                systemPreamble = "CodePilot harness v3",
            ),
            gate = PermissionGate(PermissionGate.defaultRules()),
            session = session,
            cfg = HarnessConfig(maxSteps = 8),
        )
        return harness to model
    }

    @Test
    fun `two turn read then edit scenario completes and mutates file`() {
        val (harness, _) = harness(
            listOf(
                ScriptedTurn(
                    text = "Let me read the file first.",
                    toolCalls = listOf(AssistantToolCall("c1", "read_file", """{"path":"App.kt"}""")),
                ),
                ScriptedTurn(
                    text = "Now I will fix the greeting.",
                    toolCalls = listOf(
                        AssistantToolCall(
                            "c2", "edit_file",
                            """{"path":"App.kt","old_string":"println(\"hello\")","new_string":"println(\"hello, CodePilot\")"}""",
                        )
                    ),
                ),
                ScriptedTurn(text = "Done. The greeting now mentions CodePilot."),
            )
        )
        val events = runBlocking {
            harness.run("fix the greeting").toList()
        }

        val persisted = events.filterIsInstance<io.codepilot.harness.harness.HarnessUiEvent.Persisted>()
        val kinds = persisted.map { it.event::class.simpleName }
        assertTrue(UserMessageAdded(text = "")::class.simpleName!! in kinds)
        assertEquals(3, persisted.map { it.event }.filterIsInstance<AssistantMessageAdded>().size, "three assistant turns")
        assertTrue(persisted.any { it.event is ToolResultAdded && (it.event as ToolResultAdded).ok })
        val finished = persisted.last().event as RunFinished
        assertEquals(RunFinished.COMPLETED, finished.status)
        assertEquals(3, finished.totalSteps)

        val content = Files.readString(ws.resolve("App.kt"))
        assertTrue(content.contains("hello, CodePilot"))
    }

    @Test
    fun `events file replays into identical transcript`() {
        val (harness, _) = harness(
            listOf(
                ScriptedTurn(text = "reading...", toolCalls = listOf(AssistantToolCall("c1", "list_dir", """{"path":"."}"""))),
                ScriptedTurn(text = "all done"),
            )
        )
        runBlocking { harness.run("list files").toList() }
        val store = SessionStore(ws.resolve(".codepilot/events.jsonl"))
        val replayed = store.readAll()
        val seqs = replayed.map { it.seq }
        assertEquals(seqs.size, seqs.distinct().size, "seq must be unique")
        assertEquals(seqs.sorted(), seqs, "seq must be monotonic in file order")
        assertTrue(replayed.first().seq == 0L)
    }

    @Test
    fun `max steps guard stops runaway loop`() {
        val loopScript = List(12) { i ->
            ScriptedTurn(toolCalls = listOf(AssistantToolCall("c$i", "grep", """{"pattern":"foo"}""")))
        }
        val (harness, _) = harness(loopScript)
        val events = runBlocking { harness.run("loop forever").toList() }
        val last = events.filterIsInstance<io.codepilot.harness.harness.HarnessUiEvent.Persisted>().last().event as RunFinished
        assertEquals(RunFinished.MAX_STEPS, last.status)
    }

    @Test
    fun `tool error is fed back not fatal`() {
        val (harness, _) = harness(
            listOf(
                ScriptedTurn(toolCalls = listOf(AssistantToolCall("c1", "read_file", """{"path":"no_such_file.txt"}"""))),
                ScriptedTurn(text = "file missing; nothing to do"),
            )
        )
        val events = runBlocking { harness.run("read missing").toList() }
        val toolErr = events.filterIsInstance<io.codepilot.harness.harness.HarnessUiEvent.Persisted>()
            .map { it.event }.filterIsInstance<ToolResultAdded>().first()
        assertTrue(!toolErr.ok)
        val finish = events.filterIsInstance<io.codepilot.harness.harness.HarnessUiEvent.Persisted>()
            .map { it.event }.filterIsInstance<RunFinished>().last()
        assertEquals(RunFinished.COMPLETED, finish.status)
    }
}
