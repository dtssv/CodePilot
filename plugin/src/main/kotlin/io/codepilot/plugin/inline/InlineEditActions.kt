package io.codepilot.plugin.inline

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil

/**
 * Cmd+K / Ctrl+K — open the inline edit popup for the current selection (or
 * the enclosing function if there is no selection).
 */
class InlineEditAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val (start, end) = resolveRange(editor, e.getData(CommonDataKeys.PSI_FILE))
        InlineEditController.getInstance(project).open(editor, start, end)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    /**
     * Default to the user's selection; otherwise pick the smallest enclosing
     * function-like PsiElement around the caret; otherwise fall back to caret
     * line range.
     */
    private fun resolveRange(editor: Editor, psi: PsiFile?): Pair<Int, Int> {
        val sel = editor.selectionModel
        if (sel.hasSelection()) return sel.selectionStart to sel.selectionEnd
        val caret = editor.caretModel.offset
        if (psi != null) {
            val element = psi.findElementAt(caret)
            val enclosing = element?.let { findFunctionLike(it) }
            if (enclosing != null) return enclosing.textRange.startOffset to enclosing.textRange.endOffset
        }
        val doc = editor.document
        val lineNum = doc.getLineNumber(caret)
        return doc.getLineStartOffset(lineNum) to doc.getLineEndOffset(lineNum)
    }

    private fun findFunctionLike(element: PsiElement): PsiElement? {
        // Generic heuristic — search for an ancestor whose class name contains
        // "Function" / "Method" so we don't have to depend on any language module.
        var cur: PsiElement? = element
        while (cur != null) {
            val cn = cur.javaClass.simpleName
            if (cn.contains("Function") || cn.contains("Method") || cn.contains("Lambda")) return cur
            cur = cur.parent
        }
        // Fall back to PsiTreeUtil to find any named element.
        return PsiTreeUtil.findFirstParent(element, true) { p ->
            val cn = p.javaClass.simpleName
            cn.endsWith("Declaration") || cn.endsWith("Definition")
        }
    }
}

/** Alt+Y — accept the proposed inline edit (commits via [io.codepilot.plugin.apply.PatchStaging]). */
class AcceptInlineEditAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        InlineEditController.getInstance(project).accept(editor)
    }
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = sessionExists(e)
    }
}

/** Alt+N — reject the proposed inline edit and dismiss the inlay. */
class RejectInlineEditAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        InlineEditController.getInstance(project).reject(editor)
    }
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = sessionExists(e)
    }
}

/** Alt+R — discard the current proposal and reopen the intent popup. */
class RewriteInlineEditAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        InlineEditController.getInstance(project).rewrite(editor)
    }
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = sessionExists(e)
    }
}

private fun sessionExists(e: AnActionEvent): Boolean {
    val project = e.project ?: return false
    val editor = e.getData(CommonDataKeys.EDITOR) ?: return false
    return InlineEditController.getInstance(project).sessionFor(editor) != null
}
