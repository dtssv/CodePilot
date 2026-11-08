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
 * Base for editor actions that hand the current selection (or whole file) to the
 * CodePilot chat as a reference. Subclasses decide whether to open a new chat.
 */
abstract class AddToChatBase(private val newChat: Boolean) : AnAction() {

    private val log = logger<AddToChatBase>()

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
 // Walk to the content's ChatPanel and inject the reference into its input.
            tw.contentManager.contents.firstOrNull()?.component?.let { comp ->
                val chat = comp.getClientProperty(ChatToolWindowFactory.CHAT_PANEL_KEY) as? ChatHost
                chat?.addEditorContext(filePath, language, text, newChat)
            }
        }
    }
}

/** Editor action: add the selection to the CURRENT chat (Cursor "Add to Chat"). */
class AddToChatAction : AddToChatBase(newChat = false)

/** Editor action: add the selection to a NEW chat (Cursor "Add to New Chat"). */
class AddToNewChatAction : AddToChatBase(newChat = true)

/** Toolbar / Tools-menu shortcut: opens the chat tool window. */
class ShowToolWindowAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ToolWindowManager.getInstance(project).getToolWindow("CodePilot")?.activate(null)
    }
}