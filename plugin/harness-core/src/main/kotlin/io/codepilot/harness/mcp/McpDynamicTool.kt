package io.codepilot.harness.mcp

import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One instance per tool discovered from an MCP server via `tools/list`.
 *
 * Each call is forwarded to the owning server via [McpProcessManager.call]
 * with `tools/call`. The tool name is namespaced as `mcp.<serverId>.<tool>`
 * to avoid collisions with built-in tools — the harness loop should pass
 * this [spec] name through unchanged.
 *
 * Risk classification: MCP tools are treated as [DangerLevel.EXEC] by default
 * (they can run arbitrary code on the MCP server side); the IDE adapter can
 * override this per-server via [McpPermissionGate].
 */
class McpDynamicTool(
    private val manager: McpProcessManager,
    private val serverId: String,
    private val toolName: String,
    description: String,
    parametersJson: String,
) : Tool {
    override val spec = ToolSpec(
        name = "mcp.$serverId.$toolName",
        description = description,
        parametersJson = parametersJson,
        dangerLevel = DangerLevel.EXEC,
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val params = buildJsonObject {
            put("name", toolName)
            put("arguments", args)
        }
        val result = manager.call(serverId, "tools/call", params)
        val obj = result as? JsonObject
        val content = obj?.get("content") as? kotlinx.serialization.json.JsonArray
        val text = content?.joinToString("") { c ->
            (c as? JsonObject)?.get("text")?.let { (it as? JsonPrimitive)?.content } ?: ""
        } ?: result.toString()
        val isError = (obj?.get("isError") as? JsonPrimitive)?.content?.toBoolean() ?: false
        if (isError) ToolOutput.failure("mcp error: $text")
        else ToolOutput.success(text)
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }
}
