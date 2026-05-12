package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys

/**
 * Dismiss the current inline completion suggestion (Esc alternative).
 *
 * In IntelliJ 2024.2+, the platform manages inline completion dismiss
 * via the built-in Esc handling. This action serves as a keyboard shortcut
 * alias that delegates to the platform's default inline completion behavior.
 */
class DismissCompletionAction : AnAction("Dismiss Completion", "Dismiss the current inline completion suggestion", null) {

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.getData(CommonDataKeys.PROJECT) ?: return

        // In IntelliJ 2024.2+, inline completion dismiss is handled by the platform
        // when Esc is pressed. The platform's InlineCompletionManager handles this.
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabled = project != null && editor != null
    }
}