package com.codepilot.idea

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile

/**
 * Editor right-click action: "Ask CodePilot".
 *
 * If there's a selection, sends the file path + selected snippet to the chat as a
 * prefilled prompt. If there's no selection, sends the entire current file.
 */
class AskAction : AnAction() {

    private val log = logger<AskAction>()

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project: Project = e.project ?: return
        val editor: Editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val psiFile: PsiFile? = e.getData(CommonDataKeys.PSI_FILE)
        val virtualFile = psiFile?.virtualFile
        val document = editor.document

        // Ensure the document is committed so we get the current text.
        PsiDocumentManager.getInstance(project).commitDocument(document)
        FileDocumentManager.getInstance().saveDocument(document)

        val selectedText = editor.selectionModel.selectedText
        val (text, language) = when {
            !selectedText.isNullOrBlank() -> selectedText to psiFile?.language?.id
            else -> document.text to psiFile?.language?.id
        }

        val filePath = virtualFile?.path ?: "(unsaved)"

        // Open / focus the CodePilot tool window.
        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot")
        if (tw == null) {
            log.warn("CodePilot tool window is not registered.")
            return
        }
        tw.activate {
            // Walk to the content's ChatPanel and prefill its input.
            tw.contentManager.contents.firstOrNull()?.component?.let { comp ->
                val chat = comp.getClientProperty(ChatToolWindowFactory.CHAT_PANEL_KEY) as? ChatPanel
                chat?.sendEditorContext(filePath, language, text)
            }
        }
    }
}

/** Toolbar / Tools-menu shortcut: opens the chat tool window. */
class ShowToolWindowAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ToolWindowManager.getInstance(project).getToolWindow("CodePilot")?.activate(null)
    }
}