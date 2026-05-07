package io.codepilot.plugin.toolwindow

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/**
 * Project-level registry that holds a reference to the active [CefChatPanel].
 * This allows actions (Refactor, Review, GenTest, etc.) to dispatch events to
 * the WebUI without reaching into the ToolWindow internals.
 */
@Service(Service.Level.PROJECT)
class CefChatPanelRegistry {

    @Volatile
    private var panel: CefChatPanel? = null

    fun register(panel: CefChatPanel) {
        this.panel = panel
    }

    fun get(): CefChatPanel? = panel

    companion object {
        @JvmStatic
        fun getInstance(project: Project): CefChatPanel? =
            project.service<CefChatPanelRegistry>().get()
    }
}