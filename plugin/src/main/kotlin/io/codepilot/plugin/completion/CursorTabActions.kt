package io.codepilot.plugin.completion

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

class AcceptCursorTabSuggestionAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        CursorTabSuggester.getInstance(project, editor).acceptCurrent()
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible =
            project != null && editor != null && CursorTabSuggester.getInstance(project, editor).hasActiveSuggestions()
    }
}

class DismissCursorTabSuggestionAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        CursorTabSuggester.getInstance(project, editor).dismiss()
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible =
            project != null && editor != null && CursorTabSuggester.getInstance(project, editor).hasActiveSuggestions()
    }
}
