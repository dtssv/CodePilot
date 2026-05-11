package io.codepilot.plugin.reset

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class SoftResetAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ResetEngine.softReset()
        NotificationGroupManager
            .getInstance()
            .getNotificationGroup("CodePilot")
            .createNotification("CodePilot soft-reset complete.", NotificationType.INFORMATION)
            .notify(e.project)
    }
}
