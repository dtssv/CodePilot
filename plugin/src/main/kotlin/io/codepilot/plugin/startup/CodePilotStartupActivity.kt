package io.codepilot.plugin.startup

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.EditorFactoryAdapter
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import io.codepilot.plugin.actions.CodePilotSelectionHint
import io.codepilot.plugin.completion.TabCompletionEditorSetup
import io.codepilot.plugin.indexer.IndexScheduler
import io.codepilot.plugin.reset.ResetEngine
import io.codepilot.plugin.update.UpdateService

/** Runs on first project open: consumes any external reset sentinels and kicks off update check. */
class CodePilotStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        if (ResetEngine.consumeExternalSentinels()) {
            NotificationGroupManager
                .getInstance()
                .getNotificationGroup("CodePilot")
                .createNotification(
                    "CodePilot: external reset sentinel consumed. Earlier data was moved to ~/.codePilot.broken-*.",
                    NotificationType.INFORMATION,
                ).notify(project)
        }
        UpdateService.getInstance().checkInBackground(project)

        // Start background codebase indexing
        IndexScheduler.getInstance(project).start()

        // ★ Integration: Trigger conversation history sync on startup
        // Downloads remote sessions to merge with local, enabling cross-device continuity
        Thread({
            try {
                val syncResponse = io.codepilot.plugin.session.ConversationHistorySync.sync(project)
                if (syncResponse != null && syncResponse.sessions.isNotEmpty()) {
                    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                        com.intellij.notification.NotificationGroupManager
                            .getInstance()
                            .getNotificationGroup("CodePilot")
                            .createNotification(
                                "CodePilot: Synced ${syncResponse.sessions.size} session(s) from cloud.",
                                com.intellij.notification.NotificationType.INFORMATION,
                            ).notify(project)
                    }
                }
            } catch (_: Exception) { /* Non-critical: sync failure should not block startup */ }
        }, "codepilot-session-sync").apply { isDaemon = true; start() }

        val editorFactory = EditorFactory.getInstance()
        for (editor in editorFactory.allEditors) {
            if (editor.project == project) {
                CodePilotSelectionHint.install(editor, project)
                TabCompletionEditorSetup.install(editor, project)
            }
        }

        editorFactory.addEditorFactoryListener(
            object : EditorFactoryAdapter() {
                override fun editorCreated(event: EditorFactoryEvent) {
                    val editor = event.editor
                    val proj = editor.project ?: return
                    if (proj != project) return
                    CodePilotSelectionHint.install(editor, proj)
                    TabCompletionEditorSetup.install(editor, proj)
                }

                override fun editorReleased(event: EditorFactoryEvent) {
                    CodePilotSelectionHint.uninstall()
                    val editor = event.editor
                    val proj = editor.project ?: return
                    if (proj != project) return
                    TabCompletionEditorSetup.release(editor, proj)
                }
            },
            project,
        )
    }
}
