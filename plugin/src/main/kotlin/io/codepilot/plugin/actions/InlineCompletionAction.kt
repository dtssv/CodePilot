package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import io.codepilot.plugin.completion.InlineCompletionService
import io.codepilot.plugin.settings.CodePilotSettings

/**
 * Manually trigger inline code completion (Ctrl+Shift+J).
 *
 * Unlike auto-completion (which fires on typing via CodePilotInlineCompletionProvider),
 * this action explicitly requests a completion at the current cursor position.
 *
 * In IntelliJ 2024.2+, the InlineCompletionHandler API changed and no longer
 * exposes getInstance()/DirectInvocation directly. This action uses the fallback
 * path to directly call InlineCompletionService and insert the result.
 *
 * This mirrors Cursor's behavior where pressing the completion shortcut
 * forces a suggestion even when auto-trigger conditions aren't met.
 */
class InlineCompletionAction : AnAction(
    "Inline Completion",
    "Manually trigger AI code completion at cursor",
    null,
) {

    private val log = logger<InlineCompletionAction>()

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return

        if (CodePilotSettings.getInstance().accessToken() == null) {
            log.warn("No access token configured, skipping inline completion")
            return
        }

        // Directly call InlineCompletionService and insert the result
        directCompletion(project, editor)
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        val editor = e.getData(CommonDataKeys.EDITOR)
        val hasToken = CodePilotSettings.getInstance().accessToken() != null
        e.presentation.isEnabled = project != null && editor != null && hasToken
    }

    /**
     * Directly call InlineCompletionService.complete() and insert the result.
     */
    private fun directCompletion(project: Project, editor: Editor) {
        val document = editor.document
        val offset = editor.caretModel.offset
        val text = document.text
        if (text.isEmpty()) return

        val prefixStart = maxOf(0, offset - 2000)
        val suffixEnd = minOf(text.length, offset + 1000)
        val prefix = text.substring(prefixStart, offset)
        val suffix = text.substring(offset, suffixEnd)

        val virtualFile = editor.virtualFile ?: return
        val filePath = virtualFile.path.removePrefix(project.basePath ?: "").removePrefix("/")
        val language = virtualFile.fileType.name.lowercase()

        ApplicationManager.getApplication().executeOnPooledThread {
            val request = InlineCompletionService.CompletionRequest(
                prefix = prefix,
                suffix = suffix,
                language = language,
                filePath = filePath,
            )

            val result = InlineCompletionService.complete(request)
            if (result != null && result.isNotEmpty()) {
                ApplicationManager.getApplication().invokeLater {
                    com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
                        document.insertString(offset, result)
                    }
                    // Move cursor to end of inserted text
                    editor.caretModel.moveToOffset(offset + result.length)
                }
            }
        }
    }
}