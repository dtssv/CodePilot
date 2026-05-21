package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiDirectory
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiMethod
import io.codepilot.plugin.i18n.CodePilotBundle
import io.codepilot.plugin.toolwindow.CefChatPanelRegistry

/**
 * Adds the selected context (code block / file / package) to the current chat.
 *
 * The WebUI receives TWO pieces of data per context item:
 *   - `display`: a compact summary shown in the chip (e.g. "Foo.java :12-35")
 *   - `fullCode`: the complete source text sent to the backend when the user sends a message
 *
 * Context types:
 *   - code block → "FileName.java :startLine-endLine"
 *   - file       → "FileName.java"
 *   - package    → "com.example.pkg"
 */
class AddToChatAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val psiFile = e.getData(CommonDataKeys.PSI_FILE)
        val psiElement = e.getData(CommonDataKeys.PSI_ELEMENT)

        // Try to determine context type and build display / fullCode
        val contextItem = buildContextStatic(editor, psiFile, psiElement)
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
                sink.focusChatTab()
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
        // Always visible; enabled when project is available
        // (context availability is checked in actionPerformed)
        e.presentation.isEnabled = project != null
    }

    data class ContextItem(
        val type: String, // "code" | "file" | "package" | "symbol"
        val display: String, // compact label for the chip
        val fullCode: String, // complete text sent to backend
        val filePath: String,
        val language: String,
        val startLine: Int?, // 1-based, null for file/package
        val endLine: Int?,
    )

    companion object {
        fun buildContextStatic(
            editor: Editor?,
            psiFile: PsiFile?,
            psiElement: Any?,
        ): ContextItem? = buildContext(editor, psiFile, psiElement)

        private fun buildContext(
            editor: Editor?,
            psiFile: PsiFile?,
            psiElement: Any?,
        ): ContextItem? {
            // 1. Code selection in editor
            val selectedText = editor?.selectionModel?.selectedText
            if (!selectedText.isNullOrBlank() && psiFile != null) {
                val selModel = editor.selectionModel
                val doc = editor.document
                val startLine = doc.getLineNumber(selModel.selectionStart) + 1 // 1-based
                val endLine = doc.getLineNumber(selModel.selectionEnd) + 1
                val fileName = psiFile.virtualFile?.name ?: psiFile.name
                val lang = psiFile.language?.id ?: "text"
                val path = psiFile.virtualFile?.path ?: ""
                return ContextItem(
                    type = "code",
                    display = "$fileName :$startLine-$endLine",
                    fullCode = selectedText,
                    filePath = path,
                    language = lang,
                    startLine = startLine,
                    endLine = endLine,
                )
            }

            // 2. Class or method under caret (editor, no selection)
            if (editor != null && psiFile != null && selectedText.isNullOrBlank()) {
                val elem = psiElement as? PsiElement
                if (elem != null && elem.containingFile == psiFile && (elem is PsiClass || elem is PsiMethod)) {
                    val doc = editor.document
                    val range = elem.textRange
                    val startLine = doc.getLineNumber(range.startOffset) + 1
                    val endLine = (doc.getLineNumber(range.endOffset) + 1).coerceAtLeast(startLine)
                    val fileName = psiFile.virtualFile?.name ?: psiFile.name
                    val lang = psiFile.language?.id ?: "text"
                    val path = psiFile.virtualFile?.path ?: ""
                    val name =
                        when (elem) {
                            is PsiClass -> elem.name ?: "Class"
                            is PsiMethod -> elem.name ?: "Method"
                            else -> "Symbol"
                        }
                    val kind =
                        when (elem) {
                            is PsiClass -> "class"
                            is PsiMethod -> "method"
                            else -> "symbol"
                        }
                    val kindLabel = CodePilotBundle.message("psiKind.$kind")
                    return ContextItem(
                        type = "symbol",
                        display = "$kindLabel «$name» — $fileName :$startLine-$endLine",
                        fullCode = elem.text,
                        filePath = path,
                        language = lang,
                        startLine = startLine,
                        endLine = endLine,
                    )
                }
            }

            // 3. Package / directory (from Project View)
            if (psiElement is PsiDirectory) {
                val dirName = psiElement.name ?: "package"
                val vPath = psiElement.virtualFile?.path ?: ""
                return ContextItem(
                    type = "package",
                    display = dirName,
                    fullCode = "// Package dir: $dirName\n// Path: $vPath\n// Files: ${psiElement.files.map { it.name }.joinToString(
                        ", ",
                    )}",
                    filePath = vPath,
                    language = "",
                    startLine = null as Int?,
                    endLine = null as Int?,
                )
            }

            // 4. Whole file (no selection, from Project View or editor)
            if (psiFile != null && psiFile.text.isNotBlank()) {
                val fileName = psiFile.virtualFile?.name ?: psiFile.name
                val lang = psiFile.language?.id ?: "text"
                val path = psiFile.virtualFile?.path ?: ""
                return ContextItem(
                    type = "file",
                    display = fileName,
                    fullCode = psiFile.text,
                    filePath = path,
                    language = lang,
                    startLine = null,
                    endLine = null,
                )
            }

            return null
        }
    }
}
