package io.codepilot.plugin.completion

import com.intellij.codeInsight.inline.completion.InlineCompletionEvent
import com.intellij.codeInsight.inline.completion.InlineCompletionProvider
import com.intellij.codeInsight.inline.completion.InlineCompletionProviderID
import com.intellij.codeInsight.inline.completion.InlineCompletionRequest
import com.intellij.codeInsight.inline.completion.elements.InlineCompletionGrayTextElement
import com.intellij.codeInsight.inline.completion.suggestion.InlineCompletionSingleSuggestion
import com.intellij.codeInsight.inline.completion.suggestion.InlineCompletionSuggestion
import com.intellij.openapi.application.readAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import kotlinx.coroutines.delay

/**
 * IntelliJ InlineCompletionProvider for CodePilot Tab (ghost text on typing).
 *
 * Uses the 2024.2+ suggestion API ([InlineCompletionSingleSuggestion]) — the legacy
 * [InlineCompletionSuggestion.Default] factory was removed and prevented suggestions
 * from appearing.
 */
class CodePilotInlineCompletionProvider : InlineCompletionProvider {
    override val id: InlineCompletionProviderID
        get() = InlineCompletionProviderID("CodePilot")

    override val insertHandler = CodePilotInlineCompletionInsertHandler()

    override fun isEnabled(event: InlineCompletionEvent): Boolean = TabCompletionSupport.isEnabled()

    override suspend fun getSuggestion(request: InlineCompletionRequest): InlineCompletionSuggestion {
        val editor = request.editor
        val project = editor.project ?: return InlineCompletionSuggestion.Empty

        return InlineCompletionSingleSuggestion.build { _ ->
            delay(TabCompletionSupport.debounceMs())

            val context =
                readAction {
                    extractContext(editor, project)
                } ?: return@build

            if (!TabCompletionSupport.hasEnoughPrefix(context.prefix)) return@build

            val completionRequest =
                InlineCompletionService.CompletionRequest(
                    prefix = context.prefix,
                    suffix = context.suffix,
                    language = context.language,
                    filePath = context.filePath,
                )

            val t0 = System.currentTimeMillis()
            val result = InlineCompletionService.complete(completionRequest)
            if (result != null) {
                TabFeedback.getInstance().recordSuggest(
                    project,
                    context.filePath,
                    System.currentTimeMillis() - t0,
                    result.length,
                )
                emit(InlineCompletionGrayTextElement(result))
            }
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
