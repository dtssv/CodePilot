package io.codepilot.plugin.graph

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.intellij.openapi.project.Project
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

/**
 * User-Defined Graph Nodes — Custom pipeline stages for Agent Graph orchestration.
 * Users can define custom nodes in the Graph pipeline (e.g., "security-scan", "performance-check"),
 * specifying afterNode, condition, tools, prompt, and onFailure behavior.
 * Saved in .codepilot/graph-nodes.json per project.
 */
object UserGraphNodeRegistry {

    private val mapper = ObjectMapper()

    data class CustomNode(
        val id: String, val label: String, val afterNode: String,
        val condition: String, val tools: List<String>, val prompt: String,
        val onFailure: String, val maxRetries: Int = 0, val timeout: Int = 60,
    )

    data class GraphConfig(val customNodes: List<CustomNode>, val version: String = "1.0", val modifiedAt: Long = System.currentTimeMillis())

    private val configCache = ConcurrentHashMap<String, GraphConfig>()

    val BUILTIN_NODES = listOf("intake", "plan", "execute", "verify", "repair", "synthesize", "selfcheck", "output", "done")

    fun getConfigPath(project: Project): Path = Path.of(project.basePath!!, ".codepilot", "graph-nodes.json")

    fun loadCustomNodes(project: Project): List<CustomNode> {
        val basePath = project.basePath ?: return emptyList()
        configCache[basePath]?.let { return it.customNodes }
        val configPath = getConfigPath(project)
        if (!Files.exists(configPath)) return emptyList()
        return try {
            val root = mapper.readTree(Files.readString(configPath))
            val nodes = mutableListOf<CustomNode>()
            val arr = root.path("customNodes")
            if (arr.isArray) {
                for (n in arr) {
                    nodes.add(CustomNode(
                        id = n.path("id").asText(), label = n.path("label").asText(n.path("id").asText()),
                        afterNode = n.path("afterNode").asText("verify"), condition = n.path("condition").asText("always"),
                        tools = if (n.path("tools").isArray) n.path("tools").map { it.asText() } else emptyList(),
                        prompt = n.path("prompt").asText(""), onFailure = n.path("onFailure").asText("warn"),
                        maxRetries = n.path("maxRetries").asInt(0), timeout = n.path("timeout").asInt(60),
                    ))
                }
            }
            configCache[basePath] = GraphConfig(nodes); nodes
        } catch (_: Exception) { emptyList() }
    }

    fun saveCustomNodes(project: Project, nodes: List<CustomNode>) {
        val basePath = project.basePath ?: return
        val configPath = getConfigPath(project)
        Files.createDirectories(configPath.parent)
        val config = GraphConfig(nodes, modifiedAt = System.currentTimeMillis())
        configCache[basePath] = config
        val json = mapper.createObjectNode()
        json.put("version", config.version); json.put("modifiedAt", config.modifiedAt)
        val nodesArr = mapper.createArrayNode()
        for (n in nodes) {
            val obj = mapper.createObjectNode()
            obj.put("id", n.id); obj.put("label", n.label); obj.put("afterNode", n.afterNode)
            obj.put("condition", n.condition); val toolsArr = mapper.createArrayNode(); n.tools.forEach { toolsArr.add(it) }
            obj.set<ArrayNode>("tools", toolsArr); obj.put("prompt", n.prompt); obj.put("onFailure", n.onFailure)
            obj.put("maxRetries", n.maxRetries); obj.put("timeout", n.timeout); nodesArr.add(obj)
        }
        json.set<ArrayNode>("customNodes", nodesArr)
        Files.writeString(configPath, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(json))
    }

    fun addCustomNode(project: Project, node: CustomNode) {
        val existing = loadCustomNodes(project).toMutableList()
        existing.removeIf { it.id == node.id }; existing.add(node); saveCustomNodes(project, existing)
    }

    fun removeCustomNode(project: Project, nodeId: String) {
        val existing = loadCustomNodes(project).toMutableList()
        existing.removeIf { it.id == nodeId }; saveCustomNodes(project, existing)
    }

    fun buildFullPipeline(project: Project): List<String> {
        val customNodes = loadCustomNodes(project)
        if (customNodes.isEmpty()) return BUILTIN_NODES
        val pipeline = BUILTIN_NODES.toMutableList()
        val byAfterNode = customNodes.groupBy { it.afterNode }
        val result = mutableListOf<String>()
        for (nodeId in pipeline) { result.add(nodeId); byAfterNode[nodeId]?.let { cl -> result.addAll(cl.map { it.id }) } }
        return result
    }

    fun getCustomNode(project: Project, nodeId: String): CustomNode? = loadCustomNodes(project).find { it.id == nodeId }

    fun validateNode(node: CustomNode): List<String> {
        val errors = mutableListOf<String>()
        if (node.id.isBlank()) errors.add("Node ID cannot be blank")
        if (node.id.contains(" ")) errors.add("Node ID cannot contain spaces")
        if (node.afterNode !in BUILTIN_NODES) errors.add("afterNode '${node.afterNode}' is not a valid built-in node")
        if (node.prompt.isBlank()) errors.add("Prompt cannot be blank")
        if (node.onFailure !in listOf("warn", "abort", "continue")) errors.add("onFailure must be warn/abort/continue")
        return errors
    }

    fun createDefaultConfig(project: Project) {
        val configPath = getConfigPath(project)
        if (Files.exists(configPath)) return
        saveCustomNodes(project, listOf(
            CustomNode("security-scan", "Security Scan", "verify", "always", listOf("shell.exec"),
                "Review code for security vulnerabilities: SQL injection, XSS, path traversal, credential leaks.", "warn"),
            CustomNode("performance-check", "Performance Check", "verify", "on-change", listOf("shell.exec"),
                "Analyze code for performance issues: N+1 queries, unnecessary allocations, blocking ops.", "continue"),
        ))
    }
}