package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

/**
 * Send the current chat message (Ctrl+Enter).
 *
 * Dispatches a "send_message" event to the WebUI, which reads the
 * current input field content and submits it to the conversation.
 */
class SendMessageAction : AnAction("Send Message", "Send the current chat message", null) {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val panel = io.codepilot.plugin.toolwindow.CefChatPanelRegistry.getCefPanel(project) ?: return
        panel.dispatchToWeb("send_message", emptyMap<String, Any>())
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }
}