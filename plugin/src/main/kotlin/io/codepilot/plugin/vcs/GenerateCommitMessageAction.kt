package io.codepilot.plugin.vcs

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.vcs.commit.AbstractCommitWorkflowHandler

/**
 * Action that generates a commit message using CodePilot AI from the staged changes diff.
 * Registered in the Commit ToolWindow toolbar via plugin.xml.
 */
class GenerateCommitMessageAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return

        // Try to get the commit workflow handler from the context
        val commitMessage = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL)
        if (commitMessage == null) {
            Messages.showInfoMessage(project, "Please open the Commit panel first.", "CodePilot")
            return
        }

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "CodePilot: Generating commit message...", true) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                indicator.text = "Collecting staged changes..."

                val diff = CommitMessageGenerator.getStagedDiff(project)
                if (diff.isNullOrBlank()) {
                    showInfo(project, "No staged changes found. Please stage your changes first.")
                    return
                }

                indicator.text = "Generating commit message..."

                val branchName = CommitMessageGenerator.getCurrentBranch(project)
                val recentCommits = CommitMessageGenerator.getRecentCommitMessages(project)

                val message = CommitMessageGenerator.generate(diff, branchName, recentCommits)
                if (message != null) {
                    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                        commitMessage.setCommitMessage(message)
                    }
                } else {
                    showInfo(project, "Failed to generate commit message. Please check your connection.")
                }
            }
        })
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    private fun showInfo(project: Project, message: String) {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            Messages.showInfoMessage(project, message, "CodePilot")
        }
    }
}