package io.codepilot.plugin.toolwindow

import com.intellij.openapi.components.service
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import io.codepilot.plugin.i18n.CodePilotBundle
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
        var jcefChatActive = false
        if (useJcef) {
            try {
                val cefPanel = CefChatPanel(project)
                project.service<CefChatPanelRegistry>().register(cefPanel)
                val content = factory.createContent(cefPanel.component, "Chat", false)
                toolWindow.contentManager.addContent(content)
                Disposer.register(toolWindow.disposable, cefPanel)
                jcefChatActive = true
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

        // Integrations live inside WebUI (App → 集成); keep Swing integrations only without JCEF chat.
        if (!jcefChatActive) {
            val integrations = IntegrationsToolPanel(project)
            toolWindow.contentManager.addContent(
                factory.createContent(integrations.component, CodePilotBundle.message("toolwindow.integrations"), false),
            )
        }
    }

    private fun addSwingChatPanel(
        factory: ContentFactory,
        toolWindow: ToolWindow,
        project: Project,
    ) {
        val chat = CodePilotChatPanel(project)
        val reg = project.service<CefChatPanelRegistry>()
        reg.register(chat)
        Disposer.register(
            toolWindow.disposable,
            object : Disposable {
                override fun dispose() {
                    reg.unregister(chat)
                }
            },
        )
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
