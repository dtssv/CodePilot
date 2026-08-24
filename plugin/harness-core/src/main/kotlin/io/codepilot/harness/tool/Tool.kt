package io.codepilot.harness.tool

import io.codepilot.harness.model.ToolSchema
import kotlinx.serialization.json.JsonObject

data class ToolSpec(
    val name: String,
    val description: String,
    val parametersJson: String,
    val dangerLevel: DangerLevel = DangerLevel.SAFE,
)

enum class DangerLevel { SAFE, WRITE, EXEC }

data class ToolCall(val id: String, val name: String, val argumentsJson: String)

data class ToolOutput(
    val ok: Boolean,
    val stdout: String = "",
    val stderr: String = "",
    val exitCode: Int = 0,
    val truncated: Boolean = false,
) {
    companion object {
        fun success(stdout: String, truncated: Boolean = false) = ToolOutput(true, stdout, "", 0, truncated)
        fun failure(stderr: String, exitCode: Int = 1) = ToolOutput(false, "", stderr, exitCode)
    }
}

interface Tool {
    val spec: ToolSpec
    suspend fun execute(args: JsonObject): ToolOutput
}

class ToolCatalog(tools: List<Tool>) {
    private val byName = tools.associateBy { it.spec.name }

    val schemas: List<ToolSchema>
        get() = byName.values.map { ToolSchema(it.spec.name, it.spec.description, it.spec.parametersJson) }

    fun get(name: String): Tool? = byName[name]

    val names: Set<String> get() = byName.keys
}
