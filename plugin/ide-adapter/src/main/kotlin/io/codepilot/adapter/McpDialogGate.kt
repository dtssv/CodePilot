package io.codepilot.adapter

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import io.codepilot.harness.mcp.McpPermissionGate

/**
 * Bridges the harness-core [McpPermissionGate.ApprovalRequest] to an IntelliJ
 * modal dialog.
 *
 * The harness loop calls [McpPermissionGate.checkSuspend] with the suspending
 * approval handler produced here. When the user is asked, we pop a
 * [Messages.showOkCancelDialog] on the EDT and resolve the request.
 */
class McpDialogGate(private val project: Project) {

    /**
     * Suspends until the user answers the approval request, then calls
     * [request.resolver].
     */
    suspend fun ask(request: McpPermissionGate.ApprovalRequest): Boolean {
        val title = "CodePilot · MCP tool approval"
        val msg = buildString {
            appendLine("Server:  ").append(request.serverId)
            appendLine("Tool:    ").append(request.toolName)
            appendLine("Call ID: ").append(request.callId)
        }
        val rc = Messages.showOkCancelDialog(
            project,
            msg,
            title,
            "Allow",
            "Deny",
            com.intellij.openapi.ui.Messages.getWarningIcon(),
        )
        val granted = rc == Messages.OK
        request.resolver(granted)
        return granted
    }
}
