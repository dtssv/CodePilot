package io.codepilot.plugin.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import io.codepilot.plugin.marketplace.MarketplacePanel

class CodePilotToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val chat = CodePilotChatPanel(project)
        val market = MarketplacePanel(project)
        val factory = ContentFactory.getInstance()
        toolWindow.contentManager.addContent(factory.createContent(chat.component, "Chat", false))
        toolWindow.contentManager.addContent(factory.createContent(market.component, "Marketplace", false))
    }

    override fun shouldBeAvailable(project: Project) = true
}