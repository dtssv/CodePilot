package io.codepilot.plugin.completion

import com.intellij.codeInsight.inline.completion.*
import com.intellij.codeInsight.inline.completion.elements.InlineCompletionGrayTextElement
import com.intellij.openapi.application.readAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import io.codepilot.plugin.settings.CodePilotSettings
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow

/**
 * IntelliJ InlineCompletionProvider implementation for CodePilot.
 * Triggers on typing (with debounce managed by the platform) and shows gray ghost-text
 * suggestions that the user can accept with Tab.
 */
class CodePilotInlineCompletionProvider : InlineCompletionProvider {
    override val id: InlineCompletionProviderID
        get() = InlineCompletionProviderID("CodePilot")

    override fun isEnabled(event: InlineCompletionEvent): Boolean = CodePilotSettings.getInstance().accessToken() != null

    override suspend fun getSuggestion(request: InlineCompletionRequest): InlineCompletionSuggestion =
        InlineCompletionSuggestion.Default(createElement(request))

    private fun createElement(request: InlineCompletionRequest): Flow<InlineCompletionGrayTextElement> =
        channelFlow {
            val editor = request.editor
            val project = editor.project ?: return@channelFlow

            val (prefix, suffix, language, filePath) =
                readAction {
                    extractContext(editor, project)
                } ?: return@channelFlow

            // Skip very short prefixes (less than 3 chars on current line)
            val lastLine = prefix.substringAfterLast('\n', prefix)
            if (lastLine.trimStart().length < 3) return@channelFlow

            val completionRequest =
                InlineCompletionService.CompletionRequest(
                    prefix = prefix,
                    suffix = suffix,
                    language = language,
                    filePath = filePath,
                )

            val result = InlineCompletionService.complete(completionRequest)
            if (result != null) {
                send(InlineCompletionGrayTextElement(result))
            }
        }

    private fun extractContext(
        editor: Editor,
        project: Project,
    ): CompletionContext? {
        val document = editor.document
        val offset = editor.caretModel.offset
        val text = document.text
        if (text.isEmpty()) return null

        // Limit context window: 2000 chars before, 1000 chars after
        val prefixStart = maxOf(0, offset - 2000)
        val suffixEnd = minOf(text.length, offset + 1000)
        val prefix = text.substring(prefixStart, offset)
        val suffix = text.substring(offset, suffixEnd)

        val virtualFile = editor.virtualFile ?: return null
        val filePath = virtualFile.path.removePrefix(project.basePath ?: "").removePrefix("/")
        val language = virtualFile.fileType.name.lowercase()

        return CompletionContext(prefix, suffix, language, filePath)
    }

    private data class CompletionContext(
        val prefix: String,
        val suffix: String,
        val language: String,
        val filePath: String,
    )
}
