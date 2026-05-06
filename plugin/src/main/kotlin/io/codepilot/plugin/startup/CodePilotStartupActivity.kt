package io.codepilot.plugin.startup

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import io.codepilot.plugin.reset.ResetEngine
import io.codepilot.plugin.update.UpdateService

/** Runs on first project open: consumes any external reset sentinels and kicks off update check. */
class CodePilotStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        if (ResetEngine.consumeExternalSentinels()) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("CodePilot")
                .createNotification(
                    "CodePilot: external reset sentinel consumed. Earlier data was moved to ~/.codePilot.broken-*.",
                    NotificationType.INFORMATION,
                )
                .notify(project)
        }
        UpdateService.getInstance().checkInBackground(project)
    }
}