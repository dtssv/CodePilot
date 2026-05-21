package io.codepilot.plugin.completion

import com.intellij.codeInsight.inline.completion.DefaultInlineCompletionInsertHandler
import com.intellij.codeInsight.inline.completion.InlineCompletionInsertEnvironment
import com.intellij.codeInsight.inline.completion.InlineCompletionInsertHandler
import com.intellij.codeInsight.inline.completion.elements.InlineCompletionElement

/**
 * Runs platform skip-text cleanup, records accept telemetry, then chains CodePilot Tab
 * multi-position predictions after the user accepts ghost text.
 */
class CodePilotInlineCompletionInsertHandler : InlineCompletionInsertHandler {
    override fun afterInsertion(
        environment: InlineCompletionInsertEnvironment,
        elements: List<InlineCompletionElement>,
    ) {
        DefaultInlineCompletionInsertHandler.INSTANCE.afterInsertion(environment, elements)
        val editor = environment.editor
        val project = editor.project ?: return
        val inserted = elements.joinToString("") { it.text }
        if (inserted.isEmpty()) return

        val filePath = editor.virtualFile?.path ?: ""
        TabFeedback.getInstance().recordAccept(project, filePath, inserted.length)

        try {
            val offset = environment.insertedRange.endOffset
            CodePilotTabSuggester.getInstance(project, editor).renderPredictions(offset, inserted)
        } catch (_: Exception) {
            // CodePilot Tab chain is best-effort
        }
    }
}
