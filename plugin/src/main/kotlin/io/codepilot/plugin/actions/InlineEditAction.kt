package io.codepilot.plugin.actions

import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import io.codepilot.plugin.ui.InlineDiffRenderer
import io.codepilot.plugin.ui.InlineEditPanel
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener

/**
 * Ctrl+K Inline Edit — Cursor-style inline code editing.
 *
 * When the user selects code and presses Ctrl+K:
 * 1. [InlineEditPanel] shows a popup above the selection with an instruction input field
 * 2. The user types an instruction (e.g., "add null check") and presses Enter
 * 3. The backend generates a Patch via `/v1/actions/inline-edit`
 * 4. [InlineDiffRenderer] applies the patch with an inline diff preview (green/red highlighting)
 * 5. Tab to accept, Esc to reject
 */
class InlineEditAction : AnAction("Inline Edit", "Edit selected code with AI (Ctrl+K)", null) {

    private val log = logger<InlineEditAction>()
    private val mapper = ObjectMapper()

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val psiFile = e.getData(CommonDataKeys.PSI_FILE) ?: return
        val selectionModel = editor.selectionModel

        val selectedText = selectionModel.selectedText
        if (selectedText.isNullOrBlank()) {
            // No selection: select the current line
            selectionModel.selectLineAtCaret()
            if (selectionModel.selectedText.isNullOrBlank()) return
        }

        val startOffset = selectionModel.selectionStart
        val endOffset = selectionModel.selectionEnd
        val originalText = selectionModel.selectedText ?: return

        // Use InlineEditPanel for the popup UI
        val editPanel = InlineEditPanel(
            project = project,
            editor = editor,
            onSubmit = { instruction ->
                executeInlineEdit(project, editor, psiFile, originalText, startOffset, endOffset, instruction)
            },
        )
        editPanel.showAtOffset(startOffset)
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabled = project != null && editor != null
    }

    /**
     * Execute the inline edit by calling the backend `/v1/actions/inline-edit` SSE endpoint.
     */
    private fun executeInlineEdit(
        project: Project,
        editor: Editor,
        psiFile: PsiFile,
        originalText: String,
        startOffset: Int,
        endOffset: Int,
        instruction: String,
    ) {
        val settings = CodePilotSettings.getInstance()
        val http = HttpClientService.getInstance()
        val language = psiFile.language.id
        val filePath = psiFile.virtualFile.path

        // Use InlineDiffRenderer for pending highlight
        val diffRenderer = InlineDiffRenderer(project, editor)
        val pendingHighlight = diffRenderer.showPendingHighlight(startOffset, endOffset)

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val url = (settings.state.backendBaseUrl.trimEnd('/') + "/v1/actions/inline-edit").toHttpUrl()
                val body = mapper.writeValueAsString(
                    mapOf(
                        "sessionId" to java.util.UUID.randomUUID().toString(),
                        "modelId" to null,
                        "modelSource" to null,
                        "selection" to originalText,
                        "instruction" to instruction,
                        "filePath" to filePath,
                        "language" to language,
                    ),
                )
                val request = Request.Builder()
                    .url(url)
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .header("Accept", "text/event-stream")
                    .build()

                val collector = StringBuilder()
                var patchData: String? = null

                http.openSse(request, object : EventSourceListener() {
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
                                if (text.isNotEmpty()) collector.append(text)
                            }
                            "patch" -> {
                                // Store the patch data for application
                                patchData = data
                            }
                        }
                    }

                    override fun onClosed(eventSource: EventSource) {
                        // Apply the patch on EDT
                        ApplicationManager.getApplication().invokeLater {
                            // Remove the pending highlight
                            editor.markupModel.removeHighlighter(pendingHighlight)

                            if (patchData != null) {
                                applyInlinePatch(diffRenderer, patchData!!, startOffset, endOffset, originalText)
                            } else if (collector.isNotEmpty()) {
                                // Fallback: try to extract code from the collected text
                                applyFromCollectedText(diffRenderer, collector.toString(), startOffset, endOffset, originalText)
                            }
                        }
                    }

                    override fun onFailure(
                        eventSource: EventSource,
                        t: Throwable?,
                        response: Response?,
                    ) {
                        response?.close()
                        ApplicationManager.getApplication().invokeLater {
                            editor.markupModel.removeHighlighter(pendingHighlight)
                            diffRenderer.cleanup()
                        }
                        log.error("Inline edit SSE failed", t)
                    }
                })
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    editor.markupModel.removeHighlighter(pendingHighlight)
                    diffRenderer.cleanup()
                }
                log.error("Failed to execute inline edit", e)
            }
        }
    }

    /**
     * Apply a structured Patch JSON returned by the backend.
     * Expected format: {"oldText":"...","newText":"...","explanation":"..."}
     * Also supports: {"patches":[{"newContent":"..."}]}
     */
    private fun applyInlinePatch(
        diffRenderer: InlineDiffRenderer,
        patchJson: String,
        startOffset: Int,
        endOffset: Int,
        originalText: String,
    ) {
        try {
            val patchNode = mapper.readTree(patchJson)

            // Format 1: Direct oldText/newText patch (from our inline-edit prompt)
            val oldText = patchNode.path("oldText").asText(null)
            val newText = patchNode.path("newText").asText(null)
            if (oldText != null && newText != null) {
                // Find the oldText within the original selection for precise offset
                val actualStart = originalText.indexOf(oldText)
                if (actualStart >= 0) {
                    val offsetStart = startOffset + actualStart
                    val offsetEnd = offsetStart + oldText.length
                    diffRenderer.applyWithDiff(offsetStart, offsetEnd, oldText, newText)
                } else {
                    // Fallback: replace the entire selection with newText
                    diffRenderer.applyWithDiff(startOffset, endOffset, originalText, newText)
                }
                return
            }

            // Format 2: Patches array (legacy format)
            val patches = patchNode.path("patches")
            if (patches.isArray && patches.size() > 0) {
                val patch = patches[0]
                val newContent = patch.path("newContent").asText("")
                if (newContent.isNotEmpty()) {
                    diffRenderer.applyWithDiff(startOffset, endOffset, originalText, newContent)
                }
                return
            }

            // Format 3: The entire response is the new code
            applyFromCollectedText(diffRenderer, patchJson, startOffset, endOffset, originalText)
        } catch (e: Exception) {
            log.warn("Failed to parse inline edit patch, falling back to raw text", e)
            applyFromCollectedText(diffRenderer, patchJson, startOffset, endOffset, originalText)
        }
    }

    /**
     * Fallback: apply the collected SSE text as the new code.
     */
    private fun applyFromCollectedText(
        diffRenderer: InlineDiffRenderer,
        rawText: String,
        startOffset: Int,
        endOffset: Int,
        originalText: String,
    ) {
        val cleanedCode = InlineDiffRenderer.cleanCode(rawText)
        if (cleanedCode != originalText && cleanedCode.isNotEmpty()) {
            diffRenderer.applyWithDiff(startOffset, endOffset, originalText, cleanedCode)
        }
    }
}