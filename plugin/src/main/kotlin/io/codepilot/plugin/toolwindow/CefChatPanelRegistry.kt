package io.codepilot.plugin.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/**
 * Project-level registry for the active chat panel used by IDE quick actions
 * (Refactor, Review, Add to Chat, PSI shortcuts, …).
 *
 * When JCEF chat is active the sink is [CefChatPanel]; otherwise [CodePilotChatPanel] registers itself.
 */
@Service(Service.Level.PROJECT)
class CefChatPanelRegistry {
    @Volatile
    private var sink: QuickActionChatSink? = null

    fun register(sink: QuickActionChatSink) {
        this.sink = sink
    }

    fun unregister(sink: QuickActionChatSink) {
        if (this.sink === sink) {
            this.sink = null
        }
    }

    fun getSink(): QuickActionChatSink? = sink

    companion object {
        private const val DEFAULT_RETRIES = 40

        @JvmStatic
        fun getInstance(project: Project): QuickActionChatSink? = project.service<CefChatPanelRegistry>().getSink()

        /** Only non-null when the JCEF WebUI chat tab is active. */
        @JvmStatic
        fun getCefPanel(project: Project): CefChatPanel? =
            project.service<CefChatPanelRegistry>().getSink() as? CefChatPanel

        /**
         * Runs [block] when a chat sink is available. Retries on the EDT while the tool window
         * content may still be initializing (first open after IDE startup).
         */
        @JvmStatic
        fun withSink(
            project: Project,
            retriesLeft: Int = DEFAULT_RETRIES,
            onMissing: () -> Unit = {},
            block: (QuickActionChatSink) -> Unit,
        ) {
            val sinkNow = project.service<CefChatPanelRegistry>().getSink()
            if (sinkNow != null) {
                block(sinkNow)
                return
            }
            if (retriesLeft <= 0) {
                onMissing()
                return
            }
            ApplicationManager.getApplication().invokeLater {
                withSink(project, retriesLeft - 1, onMissing, block)
            }
        }
    }
}
