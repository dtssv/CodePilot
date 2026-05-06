package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiFile
import io.codepilot.plugin.session.SessionStore
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService

/** Shared plumbing for the one-click actions (Refactor / Review / Comment / GenTest / GenDoc). */
abstract class ActionBase(private val action: String, private val presetInstruction: String) : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val psiFile = e.getData(CommonDataKeys.PSI_FILE)
        val selection = captureSelection(editor, psiFile)
        if (selection == null) {
            Messages.showInfoMessage(project, "Select code or open a file first.", "CodePilot")
            return
        }
        val input = buildInput(selection, psiFile)
        submit(project, input)
    }

    private fun captureSelection(editor: Editor?, file: PsiFile?): String? {
        val selected = editor?.selectionModel?.selectedText
        if (!selected.isNullOrBlank()) return selected
        return file?.text?.takeIf { it.isNotBlank() }
    }

    private fun buildInput(selection: String, file: PsiFile?): String {
        val path = file?.virtualFile?.path ?: "<buffer>"
        val lang = file?.language?.id ?: "text"
        val header = "[$action] file=$path lang=$lang"
        return "$header\n$presetInstruction\n\n```$lang\n$selection\n```"
    }

    private fun submit(project: Project, input: String) {
        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        tw.show {
            // Intentionally minimal: we don't reach into the panel's internals here; the user
            // simply gets the prompt ready to review in the ToolWindow. Advanced flows (direct
            // SSE call, patch preview) are added on top of this in later milestones.
            val settings = CodePilotSettings.getInstance()
            SessionStore.getInstance() // warm the service
            HttpClientService.getInstance() // warm the service
            // The panel copies the current clipboard into its input box on next open/focus.
            ClipboardBridge.push(input, settings.state.preferredLocale)
        }
    }
}

/** Cross-platform clipboard-style bridge used by the one-click actions. */
object ClipboardBridge {
    @Volatile
    var pendingInput: String? = null
        private set

    @Volatile
    var pendingLocale: String? = null
        private set

    fun push(input: String, locale: String?) {
        pendingInput = input
        pendingLocale = locale
    }

    fun consume(): String? {
        val v = pendingInput
        pendingInput = null
        return v
    }
}