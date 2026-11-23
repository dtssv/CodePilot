package com.codepilot.idea

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiDocumentManager

private val log = logger<AddToChatBase>()

/**
 * The file an action context refers to: an explicit file (project tree, editor
 * tab), else the active editor's document. Null for multi-selection and non-file
 * nodes, which have no single file to reference.
 */
private fun contextFile(e: AnActionEvent): VirtualFile? {
    val explicit = e.getData(CommonDataKeys.VIRTUAL_FILE)
        ?: e.getData(CommonDataKeys.PSI_FILE)?.virtualFile
    if (explicit != null) return explicit.takeUnless { it.isDirectory }
    val editor = e.getData(CommonDataKeys.EDITOR) ?: return null
    return FileDocumentManager.getInstance().getFile(editor.document)
}

/** 1-based inclusive line range of the editor selection; null when nothing is selected. */
private fun selectionLines(e: AnActionEvent): Pair<Int, Int>? {
    val editor: Editor = e.getData(CommonDataKeys.EDITOR) ?: return null
    if (!editor.selectionModel.hasSelection()) return null
    val document = editor.document
    e.project?.let { PsiDocumentManager.getInstance(it).getPsiFile(document) }
    val model = editor.selectionModel
    return document.getLineNumber(model.selectionStart) + 1 to
        document.getLineNumber(model.selectionEnd) + 1
}

/** Run [block] with the chat panel, opening/focusing the tool window first. */
private fun withChat(project: Project, block: (ChatHost) -> Unit) {
    val tw = ToolWindowManager.getInstance(project).getToolWindow(ChatToolWindowFactory.TOOL_WINDOW_ID)
    if (tw == null) {
        log.warn("CodePilot tool window is not registered.")
        return
    }
    tw.activate {
        val host = ChatToolWindowFactory.ensureChat(project, tw)
        if (host == null) {
            log.warn("CodePilot chat panel is not available.")
            return@activate
        }
        block(host)
    }
}

/**
 * Base for actions that hand a file (or the selected line range) to the CodePilot
 * chat as a reference.
 *
 * Works from any context that carries an [CommonDataKeys.EDITOR] **or** a
 * [CommonDataKeys.VIRTUAL_FILE] — the editor popup, the project tree, and the
 * editor tab popup all provide at least one.
 */
abstract class AddToChatBase(private val newChat: Boolean) : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && contextFile(e) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project: Project = e.project ?: return
        val file = contextFile(e) ?: return
        val range = selectionLines(e)
        withChat(project) { chat -> chat.addReference(file.path, range?.first, range?.second, newChat) }
    }
}

/** Editor/tree/tab action: add the file or selection to the CURRENT chat, without sending. */
class AddToChatAction : AddToChatBase(newChat = false)

/** Editor/tree/tab action: add the file or selection to a NEW chat, without sending. */
class AddToNewChatAction : AddToChatBase(newChat = true)

/**
 * "Ask about this code": prompts for a question and sends it straight away with
 * the file (or the selected line range) attached — the one-click counterpart of
 * adding a reference and typing yourself.
 */
class AskSelectionAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = contextFile(e)
        e.presentation.isEnabledAndVisible = e.project != null && file != null
        if (file == null) return
        val range = selectionLines(e)
        e.presentation.text = when {
            range == null -> "CodePilot: Ask About This File"
            range.first == range.second -> "CodePilot: Ask About Line ${range.first}"
            else -> "CodePilot: Ask About Lines ${range.first}–${range.second}"
        }
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project: Project = e.project ?: return
        val file = contextFile(e) ?: return
        val range = selectionLines(e)
        val target = when (range) {
            null -> file.name
            else -> "${file.name} (lines ${range.first}–${range.second})"
        }
        val question = Messages.showInputDialog(
            project,
            "What do you want to know about $target?",
            "Ask CodePilot",
            null,
            "Explain this code",
            null,
        )?.takeIf { it.isNotBlank() } ?: return
        withChat(project) { chat -> chat.askAboutCode(file.path, range?.first, range?.second, question) }
    }
}

/** Toolbar / Tools-menu shortcut: opens the chat tool window. */
class ShowToolWindowAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val tw = ToolWindowManager.getInstance(project)
            .getToolWindow(ChatToolWindowFactory.TOOL_WINDOW_ID) ?: return
        // Rebuilds the content if an older build left the tool window empty.
        ChatToolWindowFactory.ensureChat(project, tw)
        tw.activate(null)
    }
}

/** Open Settings as an editor tab (falls back to the configurable without JCEF). */
class OpenSettingsAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (SettingsEditor.open(project)) return
        withChat(project) { host -> host.openSettings() }
    }
}
