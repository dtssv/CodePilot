package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.codepilot.plugin.marketplace.LocalMarketplaceStore

/**
 * Parses MCP server JSON (same formats as [McpPanel]) and persists entries via [LocalMarketplaceStore.installMcp].
 */
object McpJsonInstaller {
    private val mapper = jacksonObjectMapper()

    /**
     * @param defaultServerName used when JSON is a single-server object (`command` / `url` only).
     * @return count and installed server ids
     */
    fun parseAndPersist(
        raw: String,
        defaultServerName: String,
    ): Result<Pair<Int, List<String>>> {
        return runCatching {
            val trimmed = raw.trim()
            require(trimmed.isNotBlank()) { "Please paste a JSON configuration." }
            val entries = parseJsonConfig(trimmed, defaultServerName)
            require(entries.isNotEmpty()) {
                "Could not parse any MCP server from the JSON. " +
                    "Expected: {\"mcpServers\":{\"name\":{\"command\":\"...\"}}} or {\"command\":\"...\"} / {\"url\":\"...\"}."
            }
            val store = LocalMarketplaceStore.getInstance()
            for (entry in entries) {
                store.installMcp(entry)
            }
            entries.size to entries.map { it.id }
        }
    }

    /**
     * Parses MCP JSON config. Supports three transport modes and multiple formats:
     *
     * Transport modes:
     * - stdio: {"command":"npx","args":[...],"env":{...}}
     * - SSE:   {"url":"https://..."}
     * - Streamable HTTP: {"url":"https://..."}
     *
     * Formats:
     * 1. Standard: {"mcpServers":{"name":{...}}}
     * 2. Single server: {"command":"..."} or {"url":"..."}
     * 3. Direct map: {"name":{...}}
     */
    private fun parseJsonConfig(
        raw: String,
        defaultServerName: String,
    ): List<LocalMarketplaceStore.McpEntry> {
        val node = mapper.readTree(raw)
        val results = mutableListOf<LocalMarketplaceStore.McpEntry>()

        if (node.has("mcpServers")) {
            val servers = node["mcpServers"]
            servers.fieldNames().forEach { name ->
                val server = servers[name]
                results.add(parseSingleServer(name, server))
            }
        } else if (node.has("command") || node.has("url")) {
            val name = defaultServerName.ifBlank { "mcp-server" }
            results.add(parseSingleServer(name, node))
        } else {
            node.fieldNames().forEach { name ->
                val server = node[name]
                if (server.isObject && (server.has("command") || server.has("url"))) {
                    results.add(parseSingleServer(name, server))
                }
            }
        }
        return results
    }

    private fun parseSingleServer(
        name: String,
        node: JsonNode,
    ): LocalMarketplaceStore.McpEntry {
        val url = node["url"]?.asText()
        val command = node["command"]?.asText()

        val transport =
            when {
                url != null && command == null -> detectTransportFromUrl(url)
                else -> LocalMarketplaceStore.McpTransport.STDIO
            }

        val env = mutableMapOf<String, String>()
        node["env"]?.fields()?.forEach { (k, v) -> env[k] = v.asText("") }
        val headers = mutableMapOf<String, String>()
        node["headers"]?.fields()?.forEach { (k, v) -> headers[k] = v.asText("") }

        if (transport == LocalMarketplaceStore.McpTransport.STDIO) {
            val cmd = command ?: error("Missing 'command' field for stdio server '$name'")
            val args = mutableListOf<String>()
            node["args"]?.forEach { args.add(it.asText()) }
            val cwd = node["cwd"]?.asText()
            return LocalMarketplaceStore.McpEntry(
                id = name,
                argv = buildList {
                    add(cmd)
                    addAll(args)
                },
                cwd = cwd,
                env = env,
                transport = transport,
                url = url,
                headers = headers,
                installedAt = java.time.Instant.now().toString(),
            )
        } else {
            val serverUrl = url ?: error("Missing 'url' field for remote server '$name'")
            return LocalMarketplaceStore.McpEntry(
                id = name,
                argv = emptyList(),
                env = env,
                transport = transport,
                url = serverUrl,
                headers = headers,
                installedAt = java.time.Instant.now().toString(),
            )
        }
    }

    private fun detectTransportFromUrl(url: String): LocalMarketplaceStore.McpTransport {
        val lower = url.lowercase()
        return if (lower.contains("/sse") || lower.contains("eventsource")) {
            LocalMarketplaceStore.McpTransport.SSE
        } else {
            LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP
        }
    }
}
