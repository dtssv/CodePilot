package io.codepilot.harness.context

import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.EventTypes
import io.codepilot.harness.event.HarnessEvent
import io.codepilot.harness.event.ToolResultAdded
import io.codepilot.harness.event.UserMessageAdded
import io.codepilot.harness.model.ChatMessage
import io.codepilot.harness.model.ChatRequest
import io.codepilot.harness.model.ToolSchema
import io.codepilot.harness.session.EventSourcedSession

interface PromptSection {
    val name: String
    val maxChars: Int
    fun compose(snapshot: List<HarnessEvent>): String
}

class IdentitySection(private val identity: String) : PromptSection {
    override val name = "identity"
    override val maxChars = 4000
    override fun compose(snapshot: List<HarnessEvent>): String = identity
}

class RulesSection(private val ruleFiles: List<String>) : PromptSection {
    override val name = "rules"
    override val maxChars = 8000
    override fun compose(snapshot: List<HarnessEvent>): String =
        ruleFiles.mapNotNull { p ->
            runCatching { java.nio.file.Files.readString(java.nio.file.Path.of(p)) }.getOrNull()
        }.joinToString("\n\n") { "# Rules from $it" }
}

class WorkspaceSection(private val workspaceSummary: () -> String) : PromptSection {
    override val name = "workspace"
    override val maxChars = 2000
    override fun compose(snapshot: List<HarnessEvent>): String = workspaceSummary()
}

/** Replays persisted events into chat messages; drops oldest beyond keepRecent, prefixing a marker. */
class HistorySection(private val keepRecent: Int = 40) : PromptSection {
    override val name = "history"
    override val maxChars = 60_000
    override fun compose(snapshot: List<HarnessEvent>): String = ""

    fun toMessages(snapshot: List<HarnessEvent>): List<ChatMessage> {
        val msgs = snapshot.mapNotNull { EventTypes.toChatMessage(it) }
        return if (msgs.size <= keepRecent) msgs
        else listOf(ChatMessage(ChatMessage.Role.USER, text = "[earlier history compacted: ${msgs.size - keepRecent} messages]")) +
            msgs.takeLast(keepRecent)
    }
}

class ContextAssembler(
    private val sections: List<PromptSection>,
    private val history: HistorySection,
    private val systemPreamble: String = "",
) {
    fun assemble(session: EventSourcedSession, tools: List<ToolSchema>, maxTokens: Int? = null): ChatRequest {
        val snap = session.events()
        var system = buildString {
            if (systemPreamble.isNotEmpty()) appendLine(systemPreamble)
            sections.forEach { sec ->
                val body = runCatching { sec.compose(snap) }.getOrDefault("")
                if (body.isNotBlank()) {
                    appendLine("## ${sec.name}")
                    appendLine(body.take(sec.maxChars))
                    appendLine()
                }
            }
        }
        return ChatRequest(system = system.trim(), messages = history.toMessages(snap), toolSchemas = tools, maxTokens = maxTokens)
    }
}
