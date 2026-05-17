package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import io.codepilot.plugin.marketplace.LocalMarketplaceStore
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

@Service(Service.Level.PROJECT)
class McpService(private val project: Project) {
    data class ServerStatus(
        val name: String,
        val state: String,
        val transport: String,
        val tools: List<ToolSpec> = emptyList(),
        val error: String? = null,
        val lastStartedAt: Long? = null,
    )

    data class ToolSpec(
        val name: String,
        val description: String = "",
        val granted: Boolean = false,
    )

    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val manager = McpProcessManager.getInstance()
    private val statuses = ConcurrentHashMap<String, ServerStatus>()
    private val grants = ConcurrentHashMap.newKeySet<String>()

    fun reloadConfig(): List<ServerStatus> {
        val cfg = readConfig()
        statuses.clear()
        for ((name, spec) in cfg) {
            statuses[name] = ServerStatus(
                name = name,
                state = if (manager.isRunning(name)) "running" else "stopped",
                transport = spec.transport,
                tools = discoverTools(name),
            )
        }
        emit()
        return list()
    }

    fun list(): List<ServerStatus> {
        if (statuses.isEmpty()) reloadConfig()
        return statuses.values.sortedBy { it.name }
    }

    fun start(name: String) {
        val spec = readConfig()[name] ?: return
        statuses[name] = ServerStatus(name, "starting", spec.transport)
        emit()
        try {
            if (spec.transport == "sse" || spec.transport == "streamable-http") {
                manager.startRemote(
                    name,
                    spec.url ?: error("missing url"),
                    if (spec.transport == "sse") LocalMarketplaceStore.McpTransport.SSE else LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP,
                    spec.headers,
                )
            } else {
                val argv = listOfNotNull(spec.command) + spec.args
                manager.start(name, McpProcessManager.McpLaunchSpec(name, argv, spec.cwd, spec.env))
            }
            statuses[name] = ServerStatus(name, "running", spec.transport, discoverTools(name), lastStartedAt = System.currentTimeMillis())
        } catch (t: Throwable) {
            statuses[name] = ServerStatus(name, "error", spec.transport, error = t.message)
        }
        emit()
    }

    fun stop(name: String) {
        manager.stop(name)
        statuses.computeIfPresent(name) { _, s -> s.copy(state = "stopped") }
        emit()
    }

    fun setGranted(server: String, tool: String, granted: Boolean) {
        val key = "$server.$tool"
        if (granted) grants.add(key) else grants.remove(key)
        statuses.computeIfPresent(server) { _, s ->
            s.copy(tools = s.tools.map { if (it.name == tool) it.copy(granted = granted) else it })
        }
        emit()
    }

    fun editConfig(content: String) {
        val p = configPath() ?: return
        Files.createDirectories(p.parent)
        Files.writeString(p, content)
        reloadConfig()
    }

    private fun discoverTools(server: String): List<ToolSpec> {
        if (!manager.isRunning(server)) return emptyList()
        return runCatching {
            val result = manager.call(server, "tools/list", emptyMap<String, Any?>())
            val tools = result.path("tools")
            if (tools.isArray) {
                tools.map {
                    val name = it.path("name").asText()
                    ToolSpec(name, it.path("description").asText(""), grants.contains("$server.$name"))
                }
            } else emptyList()
        }.getOrDefault(emptyList())
    }

    private data class Spec(
        val transport: String,
        val command: String? = null,
        val args: List<String> = emptyList(),
        val cwd: String? = null,
        val env: Map<String, String> = emptyMap(),
        val url: String? = null,
        val headers: Map<String, String> = emptyMap(),
    )

    private fun readConfig(): Map<String, Spec> {
        val p = configPath() ?: return emptyMap()
        if (!Files.exists(p)) return emptyMap()
        val root = mapper.readTree(Files.readString(p))
        val servers = root.path("mcpServers")
        if (!servers.isObject) return emptyMap()
        val out = linkedMapOf<String, Spec>()
        val fields = servers.fields()
        while (fields.hasNext()) {
            val (name, node) = fields.next()
            val transport = node.path("transport").asText(if (node.has("url")) "sse" else "stdio")
            out[name] = Spec(
                transport = transport,
                command = node.path("command").asText(null),
                args = node.path("args").takeIf { it.isArray }?.map { it.asText() } ?: emptyList(),
                cwd = node.path("cwd").asText(null),
                env = node.path("env").takeIf { it.isObject }?.fields()?.asSequence()?.associate { it.key to it.value.asText() } ?: emptyMap(),
                url = node.path("url").asText(null),
                headers = node.path("headers").takeIf { it.isObject }?.fields()?.asSequence()?.associate { it.key to it.value.asText() } ?: emptyMap(),
            )
        }
        return out
    }

    private fun configPath(): Path? = project.basePath?.let { Path.of(it, ".codepilot", "mcp.json") }

    private fun emit() {
        EventBus.getInstance(project).emit(
            turnId = "system",
            stepId = "mcp",
            type = EventTypes.MCP_STATUS,
            payload = mapOf("servers" to list()),
        )
    }

    companion object {
        fun getInstance(project: Project): McpService = project.service()
    }
}
