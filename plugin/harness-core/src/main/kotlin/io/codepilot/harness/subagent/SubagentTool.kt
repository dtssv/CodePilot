package io.codepilot.harness.subagent

import io.codepilot.harness.event.AssistantMessageAdded
import io.codepilot.harness.event.HarnessEvent
import io.codepilot.harness.harness.AgentHarness
import io.codepilot.harness.harness.HarnessConfig
import io.codepilot.harness.harness.HarnessUiEvent
import io.codepilot.harness.model.ChatMessage
import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolCatalog
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Path

/**
 * The `subagent` tool: spawns an [AgentHarness] in an isolated session.
 *
 * - The sub-agent has its own events.jsonl under [subagentDir].
 * - The sub-agent's catalog is the parent catalog filtered by [SubagentSpec.allowedTools]
 *   and with the subagent tool itself removed (to prevent recursion).
 * - Only the final assistant message (or an error summary) is returned as the tool result.
 *
 * Factory pattern: the parent harness hands in a lambda that knows how to wire an
 * AgentHarness (model + catalog + context + gate + session). This keeps the
 * subagent tool free of DI specifics.
 */
class SubagentTool(
    private val factory: (SubagentSpec) -> AgentHarness,
    private val subagentDir: Path,
) : Tool {
    override val spec = ToolSpec(
        name = "subagent",
        description = "Spawn an isolated sub-agent to do a narrowly-scoped subtask. " +
            "Returns only the final summary; intermediate tool results stay in the sub-agent's session.",
        parametersJson = """
            {"type":"object","properties":{
              "name":{"type":"string","description":"short label"},
              "goal":{"type":"string","description":"the subtask goal"},
              "allowedTools":{"type":"array","items":{"type":"string"},"description":"tool name whitelist"},
              "maxSteps":{"type":"integer","default":12}
            },"required":["name","goal"]}
        """.trimIndent(),
        dangerLevel = DangerLevel.SAFE,
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val specArg = parseSpec(args)
        val harness = factory(specArg)
        val uiEvents = harness.run(specArg.goal).toList()
        val events = uiEvents.mapNotNull { (it as? HarnessUiEvent.Persisted)?.event }
        val finalText = collectFinalAssistantText(events) ?: "[subagent ${specArg.name} produced no final text]"
        ToolOutput.success("[SUBAGENT ${specArg.name}] $finalText")
    } catch (e: Exception) {
        ToolOutput.failure("subagent failed: ${e::class.simpleName}: ${e.message}")
    }

    private fun parseSpec(args: JsonObject): SubagentSpec {
        fun s(key: String): String = (args[key] as? JsonPrimitive)?.content ?: ""
        fun i(key: String, default: Int): Int = (args[key] as? JsonPrimitive)
            ?.content?.toIntOrNull() ?: default
        val allowed = (args["allowedTools"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.content }
            ?.toSet() ?: emptySet()
        return SubagentSpec(
            name = s("name").ifBlank { "unnamed" },
            goal = s("goal"),
            allowedTools = allowed,
            maxSteps = i("maxSteps", 12),
        )
    }

    private fun collectFinalAssistantText(events: List<HarnessEvent>): String? =
        events.filterIsInstance<AssistantMessageAdded>()
            .lastOrNull()?.text?.take(MAX_RETURN_CHARS)

    companion object {
        const val MAX_RETURN_CHARS = 4_000
    }
}
