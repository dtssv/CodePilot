package com.codepilot.idea

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory

/** Hosts the chat inside the `CodePilot` tool window: [WebChatPanel], or [ChatPanel] without JCEF. */
class ChatToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        ensureChat(project, toolWindow)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true

    companion object {
        const val CHAT_PANEL_KEY = "CodePilot.chatPanel"
        const val TOOL_WINDOW_ID = "CodePilot"

        private val log = logger<ChatToolWindowFactory>()

        /**
         * The chat panel inside [toolWindow], adding the content when it is missing.
         *
         * The content is never closeable: closing it disposed the browser and left
         * the tool window with no content at all ("Nothing to show"), with no way
         * back. This call also heals a tool window emptied by an earlier build.
         */
        fun ensureChat(project: Project, toolWindow: ToolWindow): ChatHost? {
            toolWindow.contentManager.contents.firstOrNull()?.let { existing ->
                return existing.component.getClientProperty(CHAT_PANEL_KEY) as? ChatHost
            }
            return try {
                val panel: ChatHost = WebChatPanel.createOrNull(project) ?: ChatPanel(project)
                val root = panel.component
 // Stash a reference on the root so the editor add-to-chat actions can retrieve it cheaply.
                root.putClientProperty(CHAT_PANEL_KEY, panel)
                val content: Content = ContentFactory.getInstance().createContent(root, "Chat", false)
                content.isCloseable = false
                content.setDisposer {
                    try { panel.dispose() } catch (t: Throwable) { log.warn("panel dispose failed", t) }
                }
                toolWindow.contentManager.addContent(content)
                panel
            } catch (t: Throwable) {
                log.error("createToolWindowContent failed", t)
                null
            }
        }
    }
}