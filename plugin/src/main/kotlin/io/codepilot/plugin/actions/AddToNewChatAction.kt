package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import io.codepilot.plugin.i18n.CodePilotBundle
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
            Messages.showInfoMessage(
                project,
                CodePilotBundle.message("contextMenu.addToChat.needSelection"),
                "CodePilot",
            )
            return
        }

        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        if (tw.contentManager.contentCount == 0) {
            tw.show(null)
        }
        tw.show {
            CefChatPanelRegistry.withSink(
                project,
                onMissing = { ClipboardBridge.push(contextItem.fullCode, null) },
            ) { sink ->
                sink.prepareFreshChatSession()
                val ctxId = java.util.UUID.randomUUID().toString()
                sink.storeContext(ctxId, contextItem.fullCode)
                sink.dispatchContextAdded(
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
            }
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }
}
