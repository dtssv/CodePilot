package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiMethod
import io.codepilot.plugin.i18n.CodePilotBundle
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.toolwindow.CefChatPanelRegistry
import java.util.UUID

/**
 * PSI-element-scoped quick actions — same UX as [ActionBase]: i18n short prompt +
 * `\u0001` context ref → normal conversation run (no dedicated `/v1/actions/` routes on this path).
 */
abstract class PsiElementActionBase(
    private val quickActionId: String,
) : AnAction() {
    override fun update(e: AnActionEvent) {
        val element = e.getData(CommonDataKeys.PSI_ELEMENT)
        e.presentation.isEnabledAndVisible = element is PsiClass || element is PsiMethod
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val element = e.getData(CommonDataKeys.PSI_ELEMENT) as? PsiElement ?: return
        val code = element.text ?: return
        val name =
            when (element) {
                is PsiClass -> element.name ?: "Class"
                is PsiMethod -> element.name ?: "Method"
                else -> "Element"
            }
        val kind =
            when (element) {
                is PsiClass -> "class"
                is PsiMethod -> "method"
                else -> "element"
            }
        val lang = element.language?.id ?: "java"
        val containing = element.containingFile ?: return
        val vf = containing.virtualFile
        val fileName = vf?.name ?: "<buffer>"
        val path = vf?.path ?: ""
        val doc = PsiDocumentManager.getInstance(project).getDocument(containing) ?: return
        val range = element.textRange
        val startLine = doc.getLineNumber(range.startOffset) + 1
        val endLine = (doc.getLineNumber(range.endOffset) + 1).coerceAtLeast(startLine)
        val kindLabel = CodePilotBundle.message("psiKind.$kind")
        val display = "$kindLabel «$name» — $fileName"

        val tw = ToolWindowManager.getInstance(project).getToolWindow("CodePilot") ?: return
        if (tw.contentManager.contentCount == 0) {
            tw.show(null)
        }
        val prompt = CodePilotBundle.message("contextMenu.quick.psi.$quickActionId.symbol", kindLabel, name)
        tw.show {
            val ctxId = UUID.randomUUID().toString()
            val refs =
                listOf(
                    mapOf(
                        "id" to ctxId,
                        "display" to display,
                        "type" to "symbol",
                        "language" to lang,
                        "filePath" to path,
                        "startLine" to startLine,
                        "endLine" to endLine,
                    ),
                )
            CefChatPanelRegistry.withSink(
                project,
                onMissing = {
                    ClipboardBridge.push("${prompt}\n\n${code}", CodePilotSettings.getInstance().state.preferredLocale)
                },
            ) { sink ->
                sink.focusChatTab()
                sink.storeContext(ctxId, code)
                val text = "${prompt.trim()}\n\u0001${ctxId}\u0001"
                // Move the blocking network call (waitForCapacity / SSE) off the EDT.
                ApplicationManager.getApplication().executeOnPooledThread {
                    sink.submitQuickUserMessage(text, refs)
                }
            }
        }
    }
}

/** Generate unit tests for the selected class or method. */
class PsiGenTestAction :
    PsiElementActionBase("gentest")

/** Generate documentation for the selected class or method. */
class PsiGenDocAction :
    PsiElementActionBase("gendoc")

/** Generate comments for the selected class or method. */
class PsiCommentAction :
    PsiElementActionBase("comment")
