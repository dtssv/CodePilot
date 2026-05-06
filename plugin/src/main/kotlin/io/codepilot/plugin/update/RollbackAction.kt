package io.codepilot.plugin.update

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Action: CodePilot.RollbackToPreviousVersion
 *
 * Rolls back the hot-patched resources to the previously saved version.
 */
class RollbackAction : AnAction("Rollback to Previous Version") {

    override fun actionPerformed(e: AnActionEvent) {
        val registry = RuntimeResourceRegistry.getInstance()
        val success = registry.rollback()
        val group = NotificationGroupManager.getInstance().getNotificationGroup("CodePilot")
        if (success) {
            group.createNotification(
                "CodePilot rollback complete",
                "Reverted to previous version.",
                NotificationType.INFORMATION,
            ).notify(e.project)
        } else {
            group.createNotification(
                "Rollback failed",
                "No previous version available to restore.",
                NotificationType.ERROR,
            ).notify(e.project)
        }
    }
}