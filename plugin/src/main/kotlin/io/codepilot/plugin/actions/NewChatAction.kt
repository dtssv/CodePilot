package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Start a new chat session (Ctrl+Shift+L).
 *
 * Opens the CodePilot ToolWindow and starts a fresh session (abort SSE, clear handle).
 */
class NewChatAction : AnAction("New Chat", "Start a new CodePilot chat session", null) {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        tw.show {
            val sink = io.codepilot.plugin.toolwindow.CefChatPanelRegistry.getInstance(project)
            sink?.prepareFreshChatSession()
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }
}