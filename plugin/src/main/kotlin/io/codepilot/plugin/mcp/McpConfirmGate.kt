package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Gates MCP tool execution until the WebUI (or IDE fallback) approves the call.
 * Persists grants via [McpService.setGranted].
 */
@Service(Service.Level.PROJECT)
class McpConfirmGate(private val project: Project) {
    private val pending = ConcurrentHashMap<String, CompletableFuture<Boolean>>()

    /** Set by [io.codepilot.plugin.toolwindow.CefChatPanel] to forward confirm UI events. */
    @Volatile
    var webDispatcher: ((eventType: String, payload: Map<String, Any?>) -> Unit)? = null

    fun isGranted(serverId: String, toolName: String): Boolean =
        McpService.getInstance(project).isGranted(serverId, toolName)

    /**
     * Returns true if the tool may run. Blocks the tool worker thread until the user
     * responds or the wait times out (denied).
     */
    fun ensureGranted(
        serverId: String,
        toolName: String,
        fullName: String,
        args: JsonNode,
    ): Boolean {
        if (isGranted(serverId, toolName)) return true
        val confirmId = UUID.randomUUID().toString()
        val future = CompletableFuture<Boolean>()
        pending[confirmId] = future
        val argsPreview =
            runCatching { args.toPrettyString() }
                .getOrElse { args.toString() }
                .take(4000)
        val payload =
            mapOf(
                "confirmId" to confirmId,
                "serverId" to serverId,
                "toolName" to toolName,
                "fullName" to fullName,
                "argsPreview" to argsPreview,
            )
        ApplicationManager.getApplication().invokeLater {
            webDispatcher?.invoke("mcp.confirm.request", payload)
                ?: runIdeFallback(serverId, toolName, fullName, future)
        }
        return try {
            future.get(120, TimeUnit.SECONDS)
        } catch (_: Exception) {
            false
        } finally {
            pending.remove(confirmId)
        }
    }

    fun complete(
        confirmId: String,
        approved: Boolean,
        trustTool: Boolean,
        trustServer: Boolean,
        serverId: String?,
        toolName: String?,
    ) {
        val mcp = McpService.getInstance(project)
        if (approved) {
            if (trustServer && !serverId.isNullOrBlank()) {
                mcp.grantServer(serverId)
            } else if (trustTool && !serverId.isNullOrBlank() && !toolName.isNullOrBlank()) {
                mcp.setGranted(serverId, toolName, true)
            }
        }
        pending.remove(confirmId)?.complete(approved)
    }

    private fun runIdeFallback(
        serverId: String,
        toolName: String,
        fullName: String,
        future: CompletableFuture<Boolean>,
    ) {
        val approved =
            com.intellij.openapi.ui.Messages.showYesNoDialog(
                project,
                "Allow MCP tool call?\n\nServer: $serverId\nTool: $toolName\n\n$fullName",
                "MCP Tool Confirmation",
                com.intellij.openapi.ui.Messages.getQuestionIcon(),
            ) == com.intellij.openapi.ui.Messages.YES
        if (approved) {
            McpService.getInstance(project).setGranted(serverId, toolName, true)
        }
        future.complete(approved)
    }

    companion object {
        fun getInstance(project: Project): McpConfirmGate = project.service()
    }
}
