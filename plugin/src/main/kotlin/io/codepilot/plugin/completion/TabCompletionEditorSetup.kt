package io.codepilot.plugin.completion

import com.intellij.codeInsight.inline.completion.InlineCompletion
import com.intellij.codeInsight.inline.completion.InlineCompletionEventAdapter
import com.intellij.codeInsight.inline.completion.InlineCompletionEventType
import com.intellij.codeInsight.inline.completion.logs.InlineCompletionUsageTracker
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ex.util.EditorUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer

/** Per-editor wiring for CodePilot Tab suggester and inline-completion dismiss telemetry. */
object TabCompletionEditorSetup {
    fun install(
        editor: Editor,
        project: Project,
    ) {
        CodePilotTabSuggester.getInstance(project, editor)

        val handler = InlineCompletion.getHandlerOrNull(editor) ?: return
        val listenerDisposable: Disposable = Disposer.newDisposable("CodePilotTabInlineEvents")
        EditorUtil.disposeWithEditor(editor, listenerDisposable)
        handler.addEventListener(
            object : InlineCompletionEventAdapter {
                override fun onShow(event: InlineCompletionEventType.Show) {
                    TabCompletionCoordinator.setInlineActive(editor, true)
                    CodePilotTabSuggester.getInstance(project, editor).dismiss()
                }

                override fun onHide(event: InlineCompletionEventType.Hide) {
                    TabCompletionCoordinator.setInlineActive(editor, false)
                    if (event.finishType == InlineCompletionUsageTracker.ShownEvents.FinishType.SELECTED) {
                        return
                    }
                    val reason =
                        when (event.finishType) {
                            InlineCompletionUsageTracker.ShownEvents.FinishType.TYPED -> "type-out"
                            else -> event.finishType.name.lowercase()
                        }
                    TabFeedback.getInstance().recordDismiss(project, "inline-$reason")
                }
            },
            listenerDisposable,
        )
    }

    fun release(editor: Editor, project: Project) {
        CodePilotTabSuggester.release(project, editor)
    }
}
