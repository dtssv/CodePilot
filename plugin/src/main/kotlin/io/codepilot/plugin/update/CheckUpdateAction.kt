package io.codepilot.plugin.update

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class CheckUpdateAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        UpdateService.getInstance().checkInBackground(e.project)
    }
}
