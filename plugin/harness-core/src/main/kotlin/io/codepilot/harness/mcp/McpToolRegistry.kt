package io.codepilot.harness.mcp

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Discovers the tools exposed by an MCP server via `tools/list` and maintains
 * a live [McpDynamicTool] instance per discovered tool.
 *
 * Sunk conceptually from plugin/mcp/McpCallHelper.kt — the original is a thin
 * helper that calls `tools/list` and `tools/call` directly; here we wrap that
 * into a registry so the harness loop sees MCP tools as first-class [Tool]s
 * in the [ToolCatalog].
 *
 * Lifecycle:
 *   1. [refresh]        — call tools/list on a started server, build a
 *                          [McpDynamicTool] per entry, expose via [tools]
 *   2. harness loop     — discovers tools via [tools] and registers them
 *                          in its ToolCatalog
 *   3. on each tool call — McpDynamicTool delegates to tools/call on the
 *                          owning server
 */
class McpToolRegistry(
    private val manager: McpProcessManager,
) {
    @Volatile private var cache: Map<String, List<McpDynamicTool>> = emptyMap()

    /** Discover tools for [serverId]; returns the new tool list. */
    suspend fun refresh(serverId: String): List<McpDynamicTool> {
        val result = manager.call(serverId, "tools/list")
        val tools = parseToolsList(serverId, result)
        val newMap = cache.toMutableMap()
        newMap[serverId] = tools
        cache = newMap
        return tools
    }

    /** All currently-known tools across all servers. */
    fun tools(): List<McpDynamicTool> = cache.values.flatten()

    /** Tools for a specific server. */
    fun toolsFor(serverId: String): List<McpDynamicTool> = cache[serverId] ?: emptyList()

    private fun parseToolsList(serverId: String, result: JsonElement): List<McpDynamicTool> {
        val obj = result as? JsonObject ?: return emptyList()
        val arr = obj["tools"] as? kotlinx.serialization.json.JsonArray ?: return emptyList()
        return arr.mapNotNull { el ->
            val toolObj = el as? JsonObject ?: return@mapNotNull null
            val name = (toolObj["name"] as? JsonPrimitive)?.content ?: return@mapNotNull null
            val desc = (toolObj["description"] as? JsonPrimitive)?.content ?: ""
            val schema = toolObj["inputSchema"]?.toString() ?: "{}"
            McpDynamicTool(manager, serverId, name, desc, schema)
        }
    }
}
