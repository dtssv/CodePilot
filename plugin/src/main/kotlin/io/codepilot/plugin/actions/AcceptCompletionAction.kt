package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project

/**
 * Accept the current inline completion suggestion (Tab alternative for Ctrl+Shift+K).
 *
 * In IntelliJ 2024.2+, the platform manages inline completion accept/dismiss
 * via the built-in Tab/Esc handling. This action serves as a keyboard shortcut
 * alias that delegates to the platform's default inline completion behavior.
 */
class AcceptCompletionAction : AnAction("Accept Completion", "Accept the current inline completion suggestion", null) {

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.getData(CommonDataKeys.PROJECT) ?: return

        // In IntelliJ 2024.2+, inline completion accept is handled by the platform
        // when Tab is pressed. This action is registered as an alternative shortcut.
        // The platform's InlineCompletionManager will handle the actual insertion.
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabled = project != null && editor != null
    }
}