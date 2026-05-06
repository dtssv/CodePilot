package io.codepilot.plugin.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import io.codepilot.plugin.marketplace.MarketplacePanel

class CodePilotToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()

        // Use JCEF panel when available, fall back to Swing panel
        if (JBCefApp.isSupported()) {
            val cefPanel = CefChatPanel(project)
            val content = factory.createContent(cefPanel.component, "Chat", false)
            toolWindow.contentManager.addContent(content)
            Disposer.register(toolWindow.disposable, cefPanel)
        } else {
            val chat = CodePilotChatPanel(project)
            toolWindow.contentManager.addContent(factory.createContent(chat.component, "Chat", false))
        }

        val market = MarketplacePanel(project)
        toolWindow.contentManager.addContent(factory.createContent(market.component, "Marketplace", false))
    }

    override fun shouldBeAvailable(project: Project) = true
}