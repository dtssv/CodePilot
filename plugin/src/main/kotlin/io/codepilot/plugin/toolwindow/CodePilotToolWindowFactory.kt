package io.codepilot.plugin.toolwindow

import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import io.codepilot.plugin.marketplace.MarketplacePanel
import io.codepilot.plugin.mcp.McpPanel
import java.nio.file.Path

class CodePilotToolWindowFactory : ToolWindowFactory {
    private val log = logger<CodePilotToolWindowFactory>()

    override fun createToolWindowContent(
        project: Project,
        toolWindow: ToolWindow,
    ) {
        val factory = ContentFactory.getInstance()

        // Chat tab: use JCEF only if WebUI is available, otherwise always use Swing panel
        val useJcef = JBCefApp.isSupported() && isWebUiAvailable(project)
        if (useJcef) {
            try {
                val cefPanel = CefChatPanel(project)
                project.service<CefChatPanelRegistry>().register(cefPanel)
                val content = factory.createContent(cefPanel.component, "Chat", false)
                toolWindow.contentManager.addContent(content)
                Disposer.register(toolWindow.disposable, cefPanel)
            } catch (e: Exception) {
                log.warn("JCEF panel creation failed, falling back to Swing panel", e)
                addSwingChatPanel(factory, toolWindow, project)
            }
        } else {
            addSwingChatPanel(factory, toolWindow, project)
        }

        // Models tab
        val models = ModelsPanel(project)
        toolWindow.contentManager.addContent(factory.createContent(models.component, "Models", false))

        // MCP tab
        val mcp = McpPanel(project)
        toolWindow.contentManager.addContent(factory.createContent(mcp.component, "MCP", false))

        // Marketplace tab
        val market = MarketplacePanel(project)
        toolWindow.contentManager.addContent(factory.createContent(market.component, "Marketplace", false))
    }

    private fun addSwingChatPanel(
        factory: ContentFactory,
        toolWindow: ToolWindow,
        project: Project,
    ) {
        val chat = CodePilotChatPanel(project)
        toolWindow.contentManager.addContent(factory.createContent(chat.component, "Chat", false))
    }

    /** Check if WebUI dist is available (either bundled in JAR or built locally). */
    private fun isWebUiAvailable(project: Project): Boolean {
        if (javaClass.getResource("/webui/dist/index.html") != null) return true
        val devPath = Path.of(project.basePath ?: ".", "plugin", "webui", "dist", "index.html")
        return devPath.toFile().exists()
    }

    override fun shouldBeAvailable(project: Project) = true
}
