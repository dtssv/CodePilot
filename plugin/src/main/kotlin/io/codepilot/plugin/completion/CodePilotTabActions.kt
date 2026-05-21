package io.codepilot.plugin.completion

import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.openapi.editor.Caret
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.actionSystem.EditorAction
import com.intellij.openapi.editor.actionSystem.EditorActionHandler
import com.intellij.openapi.editor.actionSystem.EditorActionManager

/**
 * Tab / Esc handlers for CodePilot Tab ghost inlays. When no ghost is active,
 * delegates to the platform Tab / Escape handlers.
 */
class AcceptCodePilotTabSuggestionAction : EditorAction(AcceptCodePilotTabSuggestionHandler()) {
    init {
        templatePresentation.text = "CodePilot Tab: Accept Next Suggestion"
    }
}

class AcceptCodePilotTabSuggestionHandler : EditorActionHandler() {
    override fun isEnabledForCaret(
        editor: Editor,
        caret: Caret,
        dataContext: DataContext,
    ): Boolean {
        val project = editor.project ?: return false
        return CodePilotTabSuggester.getInstance(project, editor).hasActiveSuggestions()
    }

    override fun doExecute(
        editor: Editor,
        caret: Caret?,
        dataContext: DataContext?,
    ) {
        val project = editor.project ?: return
        if (!CodePilotTabSuggester.getInstance(project, editor).acceptCurrent()) {
            delegateTab(editor, caret, dataContext)
        }
    }

    private fun delegateTab(
        editor: Editor,
        caret: Caret?,
        dataContext: DataContext?,
    ) {
        EditorActionManager.getInstance()
            .getActionHandler(IdeActions.ACTION_EDITOR_TAB)
            .execute(editor, caret, dataContext)
    }
}

class DismissCodePilotTabSuggestionAction : EditorAction(DismissCodePilotTabSuggestionHandler()) {
    init {
        templatePresentation.text = "CodePilot Tab: Dismiss Suggestion"
    }
}

class DismissCodePilotTabSuggestionHandler : EditorActionHandler() {
    override fun isEnabledForCaret(
        editor: Editor,
        caret: Caret,
        dataContext: DataContext,
    ): Boolean {
        val project = editor.project ?: return false
        return CodePilotTabSuggester.getInstance(project, editor).hasActiveSuggestions()
    }

    override fun doExecute(
        editor: Editor,
        caret: Caret?,
        dataContext: DataContext?,
    ) {
        val project = editor.project ?: return
        if (!CodePilotTabSuggester.getInstance(project, editor).dismissAndConsume()) {
            delegateEscape(editor, caret, dataContext)
        }
    }

    private fun delegateEscape(
        editor: Editor,
        caret: Caret?,
        dataContext: DataContext?,
    ) {
        EditorActionManager.getInstance()
            .getActionHandler(IdeActions.ACTION_EDITOR_ESCAPE)
            .execute(editor, caret, dataContext)
    }
}
