package io.codepilot.intellij.context

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager

/**
 * Collects context from the IDE for sending to the backend.
 *
 * Supports:
 * - Selection: selected text in the editor
 * - File: entire file content (with PSI summary for large files)
 * - Symbol: PSI symbol info (class/method signatures)
 * - Diagnostic: current file errors/warnings
 */
class ContextCollector(private val project: Project) {

    private val log = Logger.getInstance(ContextCollector::class.java)

    /**
     * Collects context from the current editor selection.
     */
    fun fromSelection(editor: Editor): ContextItem? {
        val selectionModel = editor.selectionModel
        val selectedText = selectionModel.selectedText
        if (selectedText.isNullOrEmpty()) return null

        val file = editor.virtualFile ?: return null
        val startLine = editor.document.getLineNumber(selectionModel.selectionStart) + 1
        val endLine = editor.document.getLineNumber(selectionModel.selectionEnd) + 1

        return ContextItem(
            type = "selection",
            language = file.fileType.name.lowercase(),
            path = file.path,
            range = RangeSpec(startLine, endLine),
            content = selectedText,
            psiSummary = extractPsiSummary(editor),
            tokensEstimate = estimateTokens(selectedText)
        )
    }

    /**
     * Collects context from a virtual file.
     * For files > 2000 lines, only sends outline + PSI summary.
     */
    fun fromFile(virtualFile: VirtualFile): ContextItem? {
        try {
            val content = virtualFile.contentsToString()
            val lineCount = content.count { it == '\n' } + 1
            val language = virtualFile.fileType.name.lowercase()

            val psiSummary = if (lineCount > 2000) {
                // Large file: only send PSI outline
                extractFilePsiSummary(virtualFile)
            } else null

            return ContextItem(
                type = "file",
                language = language,
                path = virtualFile.path,
                range = RangeSpec(1, lineCount),
                content = if (lineCount <= 2000) content else null,
                psiSummary = psiSummary,
                tokensEstimate = estimateTokens(content)
            )
        } catch (e: Exception) {
            log.warn("Failed to collect context from file: ${virtualFile.path}", e)
            return null
        }
    }

    /**
     * Collects workspace context (project structure overview).
     * Returns a lightweight summary, not full content.
     */
    fun fromWorkspace(): ContextItem {
        val basePath = project.basePath ?: ""
        val projectName = project.name

        return ContextItem(
            type = "workspace",
            language = null,
            path = basePath,
            range = null,
            content = "Project: $projectName",
            psiSummary = null,
            tokensEstimate = 10
        )
    }

    /**
     * Collects diagnostics (errors/warnings) for the current file.
     */
    fun fromDiagnostics(editor: Editor): ContextItem? {
        val file = editor.virtualFile ?: return null
        // In production, use DaemonCodeAnalyzer to get diagnostics
        // For now, return a placeholder
        return ContextItem(
            type = "diagnostic",
            language = file.fileType.name.lowercase(),
            path = file.path,
            range = null,
            content = "",
            psiSummary = null,
            tokensEstimate = 0
        )
    }

    // ── PSI Summary Extraction ──────────────────────────────────────────

    private fun extractPsiSummary(editor: Editor): PsiSummary? {
        try {
            val psiFile = PsiDocumentManager.getInstance(project).getPsiFile(editor.document) ?: return null
            return buildPsiSummary(psiFile)
        } catch (e: Exception) {
            return null
        }
    }

    private fun extractFilePsiSummary(virtualFile: VirtualFile): PsiSummary? {
        try {
            val psiFile = PsiManager.getInstance(project).findFile(virtualFile) ?: return null
            return buildPsiSummary(psiFile)
        } catch (e: Exception) {
            return null
        }
    }

    private fun buildPsiSummary(psiFile: PsiFile): PsiSummary {
        // Walk PSI tree to extract class/method signatures
        val visitor = PsiOutlineVisitor()
        psiFile.accept(visitor)
        return PsiSummary(
            kind = visitor.topLevelKind,
            name = visitor.topLevelName,
            signature = visitor.topLevelSignature,
            imports = visitor.imports
        )
    }

    // ── Token Estimation ────────────────────────────────────────────────

    private fun estimateTokens(text: String): Long {
        // Rough estimation: ~3 chars per token for code
        return text.length / 3L
    }
}

/** A context item to send to the backend. */
data class ContextItem(
    val type: String,          // selection | file | symbol | diagnostic | workspace
    val language: String?,
    val path: String,
    val range: RangeSpec?,
    val content: String?,
    val psiSummary: PsiSummary?,
    val tokensEstimate: Long
)

data class RangeSpec(val startLine: Int, val endLine: Int)

data class PsiSummary(
    val kind: String?,         // class | method | field | interface
    val name: String?,
    val signature: String?,
    val imports: List<String>?
)