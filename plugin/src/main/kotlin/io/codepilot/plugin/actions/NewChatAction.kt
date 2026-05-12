package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Start a new chat session (Ctrl+Shift+L).
 *
 * Opens the CodePilot ToolWindow and sends a "new_session" event
 * to the WebUI so it clears the current conversation and starts fresh.
 */
class NewChatAction : AnAction("New Chat", "Start a new CodePilot chat session", null) {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        tw.show {
            val panel = io.codepilot.plugin.toolwindow.CefChatPanelRegistry.getInstance(project)
            panel?.dispatchToWeb("new_session", emptyMap<String, Any>())
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }
}