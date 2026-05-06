package io.codepilot.plugin.reset

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages

class HardResetAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val confirmed = Messages.showOkCancelDialog(
            e.project,
            "This will move ~/.codePilot to ~/.codePilot.broken-<ts> and restart the IDE. Continue?",
            "CodePilot: Hard reset",
            "Restart",
            "Cancel",
            Messages.getWarningIcon(),
        )
        if (confirmed != Messages.OK) return
        ResetEngine.hardResetAndMarkRestart()
        ApplicationManager.getApplication().restart()
    }
}