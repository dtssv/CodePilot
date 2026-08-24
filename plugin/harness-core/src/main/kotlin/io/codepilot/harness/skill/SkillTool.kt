package io.codepilot.harness.skill

import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/**
 * `skill` tool: let the LLM list, inspect, or activate skills by id.
 *
 * Sunk from backend/codePilot-core/.../skill/SkillTool.java (which is a
 * Spring `@RestController`-adjacent helper). Here we implement the [Tool]
 * interface so the harness loop can invoke it like any other tool.
 *
 * Operations:
 *   - op=list:                 return all available skill ids + descriptions
 *   - op=inspect&id=<name>:    return the skill body for the LLM to read
 *   - op=activate&id=<name>:   mark a skill as activated for this session
 *
 * Activation is session-scoped; it doesn't persist across runs.
 */
class SkillTool(
    private val store: SkillStore,
) : Tool {
    override val spec = ToolSpec(
        name = "skill",
        description = "List, inspect, or activate CodePilot skills. " +
            "Skills are bundles of system-prompt guidance + tool permissions that activate based on workspace signals.",
        parametersJson = """{"type":"object","properties":{
            "op":{"type":"string","enum":["list","inspect","activate"]},
            "id":{"type":"string","description":"skill name (for inspect/activate)"}
        },"required":["op"]}""",
        dangerLevel = DangerLevel.SAFE,
    )

    private val activated = mutableSetOf<String>()

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val op = args["op"]?.jsonPrimitive?.content
            ?: return ToolOutput.failure("missing op")
        when (op) {
            "list" -> {
                val skills = store.all().filter { !it.hidden }
                val body = skills.joinToString("\n") { "- ${it.name}: ${it.description}" }
                ToolOutput.success(if (body.isBlank()) "(no skills installed)" else body)
            }
            "inspect" -> {
                val id = args["id"]?.jsonPrimitive?.content
                    ?: return ToolOutput.failure("missing id")
                val skill = store.byId(id) ?: return ToolOutput.failure("skill not found: $id")
                ToolOutput.success("## ${skill.name}\n\n${skill.content}")
            }
            "activate" -> {
                val id = args["id"]?.jsonPrimitive?.content
                    ?: return ToolOutput.failure("missing id")
                val skill = store.byId(id) ?: return ToolOutput.failure("skill not found: $id")
                activated.add(id)
                ToolOutput.success("activated skill: ${skill.name}")
            }
            else -> ToolOutput.failure("unknown op: $op")
        }
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }

    /** Skills activated via tool calls in this session. */
    fun activatedIds(): Set<String> = activated.toSet()
}
