package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.project.Project
import io.codepilot.plugin.tools.ToolViolation

/** Executes MCP tool calls on the plugin (stdio / local process). */
object McpCallHelper {

    fun execute(project: Project, args: JsonNode): Map<String, Any?> {
        val fullName =
            when {
                args.has("fullName") -> args.path("fullName").asText("")
                args.has("name") -> args.path("name").asText("")
                else -> ""
            }
        if (fullName.isBlank()) {
            throw ToolViolation("mcp.call requires args.fullName (e.g. mcp.server.tool)")
        }
        val toolArgs = if (args.has("arguments")) args.path("arguments") else args
        return dispatchMcp(project, fullName, toolArgs)
    }

    fun dispatchMcp(
        project: Project,
        fullName: String,
        args: JsonNode,
    ): Map<String, Any?> {
        val parts = fullName.removePrefix("mcp.").split(".", limit = 2)
        if (parts.size < 2) throw ToolViolation("Invalid MCP tool name: $fullName")
        val serverId = parts[0]
        val toolName = parts[1]

        if (!McpConfirmGate.getInstance(project).ensureGranted(serverId, toolName, fullName, args)) {
            throw ToolViolation("MCP tool call denied: $fullName")
        }

        val mcpManager = McpProcessManager.getInstance()
        if (!mcpManager.isRunning(serverId)) {
            throw ToolViolation("MCP server not running: $serverId")
        }

        val arguments =
            if (args.isObject) {
                val map = mutableMapOf<String, Any?>()
                args.fields().forEachRemaining { (k, v) ->
                    map[k] =
                        when {
                            v.isTextual -> v.asText()
                            v.isNumber -> v.numberValue()
                            v.isBoolean -> v.booleanValue()
                            v.isNull -> null
                            else -> v.toString()
                        }
                }
                map
            } else {
                emptyMap()
            }

        val result = mcpManager.call(serverId, "tools/call", mapOf("name" to toolName, "arguments" to arguments))
        return mapOf("ok" to true, "mcpResult" to result.toString(), "fullName" to fullName)
    }
}
