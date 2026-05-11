package io.codepilot.plugin.actions

import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiFile
import io.codepilot.plugin.session.SessionStore
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import java.util.UUID

/**
 * Shared plumbing for the one-click actions (Refactor / Review / Comment / GenTest / GenDoc).
 *
 * Each action:
 *   1. Captures the selected code (or whole file)
 *   2. Opens the CodePilot ToolWindow
 *   3. Sends the context as a `user_message` to the chat panel so the user can see it
 *   4. Calls `POST /v1/actions/{action}` (SSE) and streams the result back to the chat panel
 */
abstract class ActionBase(
    private val action: String,
    private val presetInstruction: String,
) : AnAction() {
    private val log = logger<ActionBase>()
    private val mapper = ObjectMapper()

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val psiFile = e.getData(CommonDataKeys.PSI_FILE)
        val selection = captureSelection(editor, psiFile)
        if (selection == null) {
            Messages.showInfoMessage(project, "Select code or open a file first.", "CodePilot")
            return
        }
        val input = buildInput(selection, psiFile)
        submit(project, input, psiFile)
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }

    private fun captureSelection(
        editor: Editor?,
        file: PsiFile?,
    ): String? {
        val selected = editor?.selectionModel?.selectedText
        if (!selected.isNullOrBlank()) return selected
        return file?.text?.takeIf { it.isNotBlank() }
    }

    private fun buildInput(
        selection: String,
        file: PsiFile?,
    ): String {
        val path = file?.virtualFile?.path ?: "<buffer>"
        val lang = file?.language?.id ?: "text"
        val header = "[$action] file=$path lang=$lang"
        return "$header\n$presetInstruction\n\n```$lang\n$selection\n```"
    }

    private fun submit(
        project: Project,
        input: String,
        psiFile: PsiFile?,
    ) {
        // 1. Open the CodePilot ToolWindow
        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        tw.show {
            // 2. Send the action input as a user message to the chat panel
            ApplicationManager.getApplication().invokeLater {
                val panel = findCefChatPanel(project)
                if (panel != null) {
                    // Dispatch a compact action_start to the WebUI (not the full code)
                    val fileName = psiFile?.virtualFile?.name ?: "<buffer>"
                    val lang = psiFile?.language?.id ?: "text"
                    panel.dispatchToWeb(
                        "action_start",
                        mapOf(
                            "action" to action,
                            "display" to "$action: $fileName",
                            "instruction" to presetInstruction,
                        ),
                    )
                    // Call backend /v1/actions/{action} SSE endpoint
                    callActionSse(panel, input, psiFile)
                } else {
                    // Fallback: push to clipboard bridge for Swing panel
                    ClipboardBridge.push(input, CodePilotSettings.getInstance().state.preferredLocale)
                }
            }
        }
    }

    private fun findCefChatPanel(project: Project): io.codepilot.plugin.toolwindow.CefChatPanel? =
        io.codepilot.plugin.toolwindow.CefChatPanelRegistry
            .getInstance(project)

    /**
     * Call `POST /v1/actions/{action}` with SSE and stream results to the chat panel.
     */
    private fun callActionSse(
        panel: io.codepilot.plugin.toolwindow.CefChatPanel,
        input: String,
        psiFile: PsiFile?,
    ) {
        val settings = CodePilotSettings.getInstance()
        val http = HttpClientService.getInstance()
        val sessionStore = SessionStore.getInstance()
        val workspaceHash = (panel.project?.basePath ?: panel.project?.name ?: "").hashCode().toString(16)
        val sessionId = UUID.randomUUID().toString()

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val url = (settings.state.backendBaseUrl.trimEnd('/') + "/v1/actions/$action").toHttpUrl()
                val body =
                    mapper.writeValueAsString(
                        mapOf(
                            "sessionId" to sessionId,
                            "modelId" to null,
                            "context" to input,
                            "instruction" to presetInstruction,
                            "language" to (psiFile?.language?.id ?: "text"),
                            "filePath" to (psiFile?.virtualFile?.path ?: ""),
                        ),
                    )
                val request =
                    Request
                        .Builder()
                        .url(url)
                        .post(body.toRequestBody("application/json".toMediaType()))
                        .header("Accept", "text/event-stream")
                        .build()

                val collector = StringBuilder()

                http.openSse(
                    request,
                    object : EventSourceListener() {
                        override fun onEvent(
                            eventSource: EventSource,
                            id: String?,
                            type: String?,
                            data: String,
                        ) {
                            val node = mapper.readTree(data.ifEmpty { "{}" })
                            when (type) {
                                "delta" -> {
                                    val text = node.path("text").asText("")
                                    if (text.isNotEmpty()) {
                                        collector.append(text)
                                        panel.dispatchToWeb("delta", mapOf("text" to text))
                                    }
                                }
                                "patch" -> {
                                    val patchData = mapper.treeToValue(node, Map::class.java)
                                    panel.dispatchToWeb("patch", patchData)
                                }
                                "error" -> {
                                    val code = node.path("code").asInt(50001)
                                    val msg = node.path("message").asText("")
                                    panel.dispatchToWeb("error", mapOf("code" to code, "message" to msg))
                                }
                                "done" -> {
                                    panel.dispatchToWeb("done", mapOf("reason" to node.path("reason").asText("final")))
                                }
                            }
                        }

                        override fun onClosed(eventSource: EventSource) {
                            if (collector.isNotEmpty()) {
                                panel.dispatchToWeb("action_done", mapOf("action" to action, "result" to collector.toString()))
                            }
                        }

                        override fun onFailure(
                            eventSource: EventSource,
                            t: Throwable?,
                            response: Response?,
                        ) {
                            response?.close()
                            val msg = t?.message ?: "Action SSE failed"
                            panel.dispatchToWeb("error", mapOf("code" to 50002, "message" to msg))
                            log.error("Action SSE failed: $action", t)
                        }
                    },
                )
            } catch (e: Exception) {
                log.error("Failed to call action: $action", e)
                panel.dispatchToWeb("error", mapOf("code" to 50001, "message" to (e.message ?: "Unknown error")))
            }
        }
    }
}

/**
 * Cross-platform clipboard-style bridge used by the one-click actions
 * as a fallback when the CEF panel is not available.
 */
object ClipboardBridge {
    @Volatile
    var pendingInput: String? = null
        private set

    @Volatile
    var pendingLocale: String? = null
        private set

    fun push(
        input: String,
        locale: String?,
    ) {
        pendingInput = input
        pendingLocale = locale
    }

    fun consume(): String? {
        val v = pendingInput
        pendingInput = null
        return v
    }
}
