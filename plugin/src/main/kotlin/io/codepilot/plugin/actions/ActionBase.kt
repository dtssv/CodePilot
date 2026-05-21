package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiFile
import io.codepilot.plugin.i18n.CodePilotBundle
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.toolwindow.CefChatPanelRegistry
import java.util.UUID

/**
 * One-click editor / project-view actions (Refactor / Review / Comment / GenTest / GenDoc).
 *
 * They behave like a **shortcut user message** in chat: a short i18n prompt plus the same
 * context reference model as "Add to chat" (inline `\u0001ctxId\u0001` + [contextStore]),
 * then the normal [`ConversationClient.run`] / `user_message` pipeline — no dedicated `/v1/actions/` REST routes on this path.
 */
abstract class ActionBase(
    /** Logical id for bundle keys, e.g. `refactor`, `review`, `gentest`. */
    private val quickActionId: String,
) : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val psiFile = e.getData(CommonDataKeys.PSI_FILE)
        val psiElement = e.getData(CommonDataKeys.PSI_ELEMENT)
        val ctx = AddToChatAction.buildContextStatic(editor, psiFile, psiElement)
        if (ctx == null) {
            Messages.showInfoMessage(
                project,
                CodePilotBundle.message("contextMenu.addToChat.needSelection"),
                "CodePilot",
            )
            return
        }
        submitQuickTurn(project, ctx)
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }

    private fun resolvePrompt(ctx: AddToChatAction.ContextItem): String {
        val suffix =
            when (ctx.type) {
                "code",
                "symbol",
                -> "selection"
                "package" -> "package"
                else -> "file"
            }
        return CodePilotBundle.message("contextMenu.quick.$quickActionId.$suffix")
    }

    private fun submitQuickTurn(
        project: Project,
        ctx: AddToChatAction.ContextItem,
    ) {
        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        if (tw.contentManager.contentCount == 0) {
            tw.show(null)
        }
        tw.show {
            val prompt = resolvePrompt(ctx)
            val ctxId = UUID.randomUUID().toString()
            val refs =
                listOf(
                    mapOf(
                        "id" to ctxId,
                        "display" to ctx.display,
                        "type" to ctx.type,
                        "language" to (ctx.language.ifBlank { "text" }),
                        "filePath" to ctx.filePath,
                        "startLine" to ctx.startLine,
                        "endLine" to ctx.endLine,
                    ),
                )
            CefChatPanelRegistry.withSink(
                project,
                onMissing = {
                    ClipboardBridge.push("${prompt}\n\n${ctx.fullCode}", CodePilotSettings.getInstance().state.preferredLocale)
                },
            ) { sink ->
                sink.focusChatTab()
                sink.storeContext(ctxId, ctx.fullCode)
                val text = "${prompt.trim()}\n\u0001${ctxId}\u0001"
                // Move the blocking network call (waitForCapacity / SSE) off the EDT.
                ApplicationManager.getApplication().executeOnPooledThread {
                    sink.submitQuickUserMessage(text, refs)
                }
            }
        }
    }
}

/**
 * Cross-platform clipboard-style bridge used by the one-click actions
 * as a fallback when the CEF panel is not available.
 */
object ClipboardBridge {
    @Volatile
    var pendingInput: String? = null
        private set

    @Volatile
    var pendingLocale: String? = null
        private set

    fun push(
        input: String,
        locale: String?,
    ) {
        pendingInput = input
        pendingLocale = locale
    }

    fun consume(): String? {
        val v = pendingInput
        pendingInput = null
        return v
    }
}
