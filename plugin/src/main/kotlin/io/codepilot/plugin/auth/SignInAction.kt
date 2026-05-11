package io.codepilot.plugin.auth

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class SignInAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        LoginDialog(e.project).showAndGet()
    }
}
