package com.codepilot.idea

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory

/** Hosts the [ChatPanel] inside the `CodePilot` tool window. */
class ChatToolWindowFactory : ToolWindowFactory {
    private val log = logger<ChatToolWindowFactory>()

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        try {
            val panel = ChatPanel(project)
            val root = panel.component
            // Stash a reference on the root so AskAction.findChatPanel can retrieve it cheaply.
            root.putClientProperty(CHAT_PANEL_KEY, panel)
            val content: Content = ContentFactory.getInstance().createContent(root, "Chat", false)
            content.setDisposer {
                try { panel.dispose() } catch (t: Throwable) { log.warn("panel dispose failed", t) }
            }
            toolWindow.contentManager.addContent(content)
        } catch (t: Throwable) {
            log.error("createToolWindowContent failed", t)
        }
    }

    override fun shouldBeAvailable(project: Project): Boolean = true

    companion object {
        const val CHAT_PANEL_KEY = "CodePilot.chatPanel"
    }
}