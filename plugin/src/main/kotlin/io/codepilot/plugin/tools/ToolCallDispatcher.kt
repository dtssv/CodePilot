package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import io.codepilot.plugin.conversation.ConversationClient

/**
 * Unified dispatcher for tool calls received from the backend.
 * Delegates to the existing [ToolDispatcher] for actual execution.
 */
class ToolCallDispatcher(
    private val project: Project,
    private val client: ConversationClient,
    private val sessionId: String,
) {
    private val log = Logger.getInstance(ToolCallDispatcher::class.java)
    private val toolDispatcher = ToolDispatcher(project, client, sessionId)

    fun dispatch(
        toolCallId: String,
        toolName: String,
        toolArgs: JsonNode,
        callback: (ok: Boolean, result: String, error: String?) -> Unit,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                // Build a JsonNode payload matching what ToolDispatcher.dispatch expects
                val mapper = com.fasterxml.jackson.databind.ObjectMapper()
                val payload = mapper.createObjectNode().apply {
                    put("id", toolCallId)
                    put("name", toolName)
                    set<JsonNode>("args", toolArgs)
                }
                toolDispatcher.dispatch(payload)
                callback(true, "", null)
            } catch (e: Exception) {
                log.warn("Tool call $toolName ($toolCallId) failed", e)
                callback(false, "", e.message)
            }
        }
    }
}