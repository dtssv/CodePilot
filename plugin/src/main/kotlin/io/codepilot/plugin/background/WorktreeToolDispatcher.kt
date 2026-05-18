package io.codepilot.plugin.background

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.project.Project
import io.codepilot.plugin.conversation.ConversationClient
import io.codepilot.plugin.tools.ToolDispatcher
import java.nio.file.Path

/**
 * Routes background-agent tool calls through [ToolDispatcher] with a worktree workspace root,
 * so fs.* / shell.* / mcp.* behave like the main agent but write under isolation.
 */
class WorktreeToolDispatcher(
    project: Project,
    worktree: Path,
    client: ConversationClient,
    sessionId: String,
    log: (String) -> Unit,
) {
    private val dispatcher = ToolDispatcher(
        project = project,
        client = client,
        sessionId = sessionId,
        workspaceRoot = worktree,
        onToolResult = { id, ok, _ -> log("tool_result ${if (ok) "ok" else "error"} $id") },
    )

    fun dispatch(toolCall: JsonNode) {
        val name = toolCall.path("name").asText()
        if (name == "gather.execute") return
        dispatcher.dispatch(toolCall)
    }
}
