package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import io.codepilot.plugin.toolwindow.CefChatPanelRegistry

/**
 * Creates a new chat session and adds the selected context to it.
 * Equivalent to "Add to Chat" but always starts a fresh conversation.
 */
class AddToNewChatAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val psiFile = e.getData(CommonDataKeys.PSI_FILE)
        val psiElement = e.getData(CommonDataKeys.PSI_ELEMENT)

        val contextItem = AddToChatAction.buildContextStatic(editor, psiFile, psiElement)
        if (contextItem == null) {
            Messages.showInfoMessage(project, "Select code, a file, or a package first.", "CodePilot")
            return
        }

        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        tw.show {
            ApplicationManager.getApplication().invokeLater {
                val panel = CefChatPanelRegistry.getInstance(project)
                if (panel != null) {
                    // First create a new session
                    panel.handleNewSessionFromAction()
                    // Store fullCode in contextStore, send compact ref to WebUI
                    val ctxId =
                        java.util.UUID
                            .randomUUID()
                            .toString()
                    panel.storeContext(ctxId, contextItem.fullCode)
                    panel.dispatchToWeb(
                        "context_added",
                        mapOf(
                            "id" to ctxId,
                            "type" to contextItem.type,
                            "display" to contextItem.display,
                            "filePath" to contextItem.filePath,
                            "language" to contextItem.language,
                            "startLine" to contextItem.startLine,
                            "endLine" to contextItem.endLine,
                        ),
                    )
                } else {
                    ClipboardBridge.push(contextItem.fullCode, null)
                }
            }
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }
}
