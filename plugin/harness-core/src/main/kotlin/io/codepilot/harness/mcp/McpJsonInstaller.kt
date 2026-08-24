package io.codepilot.harness.mcp

/**
 * MCP server entry: one configured MCP server (stdio command, or remote URL).
 *
 * Sunk from the `LocalMarketplaceStore.McpEntry` nested record in the IDE
 * plugin. The original lives inside `LocalMarketplaceStore` (an IntelliJ
 * PersistentStateComponent); here it's a plain data class so the installer
 * and the tool registry can share it without depending on the IDE store.
 */
data class McpEntry(
    val id: String,
    val argv: List<String> = emptyList(),
    val cwd: String? = null,
    val env: Map<String, String> = emptyMap(),
    val transport: McpProcessManager.Transport = McpProcessManager.Transport.STDIO,
    val url: String? = null,
    val headers: Map<String, String> = emptyMap(),
    val installedAt: String = java.time.Instant.now().toString(),
)

/**
 * Parses MCP server JSON (mcpServers format, single-server, or direct map)
 * and produces [McpEntry] instances.
 *
 * Sunk from plugin/mcp/McpJsonInstaller.kt. The original persists via
 * `LocalMarketplaceStore.getInstance()` (an IntelliJ service); this version
 * is a pure parser — the IDE adapter / harness loop persists the returned
 * entries however it likes (filesystem JSON, etc.).
 *
 * Supported formats:
 *   1. Standard: {"mcpServers":{"name":{"command":"...","args":[...]}}}
 *   2. Single server: {"command":"..."} or {"url":"..."}
 *   3. Direct map: {"name":{"command":"..."}}
 *
 * Transport detection:
 *   - "command" present → STDIO
 *   - "url" only → SSE if url contains /sse or eventsource, else STREAMABLE_HTTP
 */
object McpJsonInstaller {

    fun parse(raw: String, defaultServerName: String = "mcp-server"): List<McpEntry> {
        val trimmed = raw.trim()
        require(trimmed.isNotBlank()) { "Please paste a JSON configuration." }
        val entries = parseJsonConfig(trimmed, defaultServerName)
        require(entries.isNotEmpty()) {
            "Could not parse any MCP server from the JSON. Expected: " +
                "{\"mcpServers\":{\"name\":{\"command\":\"...\"}}} or {\"command\":\"...\"} / {\"url\":\"...\"}."
        }
        return entries
    }

    private fun parseJsonConfig(raw: String, defaultServerName: String): List<McpEntry> {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val node = json.parseToJsonElement(raw) as? kotlinx.serialization.json.JsonObject ?: return emptyList()
        val results = mutableListOf<McpEntry>()

        if (node.containsKey("mcpServers")) {
            val servers = node["mcpServers"] as? kotlinx.serialization.json.JsonObject ?: return emptyList()
            for ((name, server) in servers) {
                val s = server as? kotlinx.serialization.json.JsonObject ?: continue
                results.add(parseSingleServer(name, s))
            }
        } else if (node.containsKey("command") || node.containsKey("url")) {
            results.add(parseSingleServer(defaultServerName.ifBlank { "mcp-server" }, node))
        } else {
            for ((name, server) in node) {
                val s = server as? kotlinx.serialization.json.JsonObject ?: continue
                if (s.containsKey("command") || s.containsKey("url")) {
                    results.add(parseSingleServer(name, s))
                }
            }
        }
        return results
    }

    private fun parseSingleServer(
        name: String,
        node: kotlinx.serialization.json.JsonObject,
    ): McpEntry {
        val url = (node["url"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val command = (node["command"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val transport = when {
            url != null && command == null -> detectTransportFromUrl(url)
            else -> McpProcessManager.Transport.STDIO
        }

        val env = mutableMapOf<String, String>()
        (node["env"] as? kotlinx.serialization.json.JsonObject)?.forEach { (k, v) ->
            (v as? kotlinx.serialization.json.JsonPrimitive)?.content?.let { env[k] = it }
        }
        val headers = mutableMapOf<String, String>()
        (node["headers"] as? kotlinx.serialization.json.JsonObject)?.forEach { (k, v) ->
            (v as? kotlinx.serialization.json.JsonPrimitive)?.content?.let { headers[k] = it }
        }
        val cwd = (node["cwd"] as? kotlinx.serialization.json.JsonPrimitive)?.content

        return if (transport == McpProcessManager.Transport.STDIO) {
            val cmd = command ?: error("Missing 'command' field for stdio server '$name'")
            val args = (node["args"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
                ?: emptyList()
            McpEntry(
                id = name, argv = listOf(cmd) + args, cwd = cwd, env = env,
                transport = transport, url = url, headers = headers,
            )
        } else {
            val serverUrl = url ?: error("Missing 'url' field for remote server '$name'")
            McpEntry(
                id = name, argv = emptyList(), env = env,
                transport = transport, url = serverUrl, headers = headers,
            )
        }
    }

    private fun detectTransportFromUrl(url: String): McpProcessManager.Transport {
        val lower = url.lowercase()
        return if (lower.contains("/sse") || lower.contains("eventsource")) {
            McpProcessManager.Transport.SSE
        } else {
            McpProcessManager.Transport.STREAMABLE_HTTP
        }
    }
}
