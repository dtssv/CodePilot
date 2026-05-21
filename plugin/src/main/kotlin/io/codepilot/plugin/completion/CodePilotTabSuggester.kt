package io.codepilot.plugin.completion

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ex.util.EditorUtil
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.InlayProperties
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import java.util.concurrent.ConcurrentHashMap

/**
 * CodePilot Tab multi-position suggester.
 *
 * After inline completion is accepted, predicts additional edit positions and
 * renders gray ghost suggestions. The user presses Tab to accept each in sequence.
 */
class CodePilotTabSuggester(private val project: Project, private val editor: Editor) {

    data class GhostSuggestion(
        val id: String = "tab-${System.nanoTime()}",
        val offset: Int,
        val text: String,
        val source: String,
        val priority: Int,
        val cursorAfter: Int = offset + text.length,
    )

    private val ghostInlays = mutableListOf<Inlay<*>>()
    private val suggestions = mutableListOf<GhostSuggestion>()
    private var currentSuggestionIdx = 0

    private val recentEdits = java.util.concurrent.ConcurrentLinkedDeque<EditRecord>()
    private val disposable = Disposer.newDisposable("CodePilotTabSuggester")
    data class EditRecord(
        val offset: Int,
        val oldText: String,
        val newText: String,
        val timestamp: Long,
    )

    companion object {
        private const val MAX_RECENT_EDITS = 20
        private val instances = ConcurrentHashMap<String, CodePilotTabSuggester>()

        fun getInstance(project: Project, editor: Editor): CodePilotTabSuggester {
            val key = instanceKey(project, editor)
            return instances.getOrPut(key) { CodePilotTabSuggester(project, editor) }
        }

        fun release(project: Project, editor: Editor) {
            instances.remove(instanceKey(project, editor))?.dispose()
        }

        private fun instanceKey(project: Project, editor: Editor): String =
            "${project.basePath}:${editor.document.hashCode()}"

        private val BLOCK_OPEN = Regex("""\{\s*$""")
        private val NEW_TYPE_USAGE = Regex("""(?:new\s+|extends\s+|implements\s+|:\s*)([A-Z]\w+)""")
        private val SIBLING_PROPERTY = Regex(""",\s*$""")
    }

    init {
        editor.document.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    recordEdit(event)
                    if (event.newFragment.isNotEmpty() || event.oldFragment.isNotEmpty()) {
                        clearGhosts()
                        scheduleRepredict(event)
                    }
                }
            },
            disposable,
        )
        EditorUtil.disposeWithEditor(editor, disposable)
    }

    private fun dispose() {
        clearGhosts()
        suggestions.clear()
        TabCompletionCoordinator.clear(editor)
        Disposer.dispose(disposable)
    }

    private fun recordEdit(event: DocumentEvent) {
        recentEdits.addLast(
            EditRecord(
                offset = event.offset,
                oldText = event.oldFragment.toString(),
                newText = event.newFragment.toString(),
                timestamp = System.currentTimeMillis(),
            ),
        )
        while (recentEdits.size > MAX_RECENT_EDITS) recentEdits.removeFirst()
    }

    private fun scheduleRepredict(event: DocumentEvent) {
        if (event.newFragment.isEmpty()) return
        if (TabCompletionCoordinator.isInlineActive(editor)) {
            return
        }
        val inserted = event.newFragment.toString()
        val offset = event.offset + inserted.length
        val heuristic = predictHeuristicEdits(offset, inserted)
        if (heuristic.isNotEmpty()) {
            applySuggestions(heuristic)
        }
        // Cursor infill is handled by [CodePilotInlineCompletionProvider] → /v1/actions/inline-completion.
        // Do not call /v1/tab/predict on every keystroke (avoids duplicate API + overlapping ghosts).
    }

    private fun applySuggestions(predicted: List<GhostSuggestion>) {
        ApplicationManager.getApplication().invokeLater {
            if (editor.isDisposed) return@invokeLater
            suggestions.clear()
            suggestions.addAll(predicted.sortedBy { it.priority })
            currentSuggestionIdx = 0
            renderCurrentGhost()
            val filePath = editor.virtualFile?.path ?: ""
            TabFeedback.getInstance().recordSuggest(
                project,
                filePath,
                0,
                predicted.sumOf { it.text.length },
            )
        }
    }

    fun predictAdditionalEdits(cursorOffset: Int, insertedText: String): List<GhostSuggestion> =
        predictHeuristicEdits(cursorOffset, insertedText)

    private fun predictHeuristicEdits(cursorOffset: Int, insertedText: String): List<GhostSuggestion> {
        val result = mutableListOf<GhostSuggestion>()
        val doc = editor.document.text
        val lineNumber = editor.document.getLineNumber(cursorOffset)
        val lineStart = editor.document.getLineStartOffset(lineNumber)
        val lineEnd = editor.document.getLineEndOffset(lineNumber)
        val currentLine = doc.substring(lineStart, minOf(lineEnd, doc.length))

        if (BLOCK_OPEN.containsMatchIn(insertedText) || BLOCK_OPEN.containsMatchIn(currentLine)) {
            val indent = currentLine.takeWhile { it == ' ' || it == '\t' }
            val nextNonBlank = doc.substring(cursorOffset).dropWhile { it == ' ' || it == '\t' || it == '\n' || it == '\r' }
            if (!nextNonBlank.startsWith("}")) {
                result.add(
                    GhostSuggestion(
                        offset = cursorOffset,
                        text = "\n${indent}}",
                        source = "bracket",
                        priority = 0,
                    ),
                )
            }
        }

        if (SIBLING_PROPERTY.containsMatchIn(currentLine) && currentLine.contains(":")) {
            val keyPattern = Regex("""(\w+)\s*:""")
            val lastKey = keyPattern.findAll(currentLine).lastOrNull()?.groupValues?.get(1)
            if (lastKey != null) {
                val indent = currentLine.takeWhile { it == ' ' || it == '\t' }
                result.add(
                    GhostSuggestion(
                        offset = cursorOffset,
                        text = "\n${indent}key: value",
                        source = "sibling",
                        priority = 2,
                    ),
                )
            }
        }

        val typeMatches = NEW_TYPE_USAGE.findAll(insertedText)
        for (match in typeMatches) {
            val typeName = match.groupValues[1]
            val importPattern = Regex("""import\s+.*\b$typeName\b""")
            if (!importPattern.containsMatchIn(doc)) {
                val firstImport = doc.lines().indexOfFirst { it.startsWith("import ") }
                if (firstImport >= 0) {
                    val importOffset = editor.document.getLineStartOffset(firstImport)
                    result.add(
                        GhostSuggestion(
                            offset = importOffset,
                            text = "import $typeName;\n",
                            source = "import",
                            priority = 1,
                        ),
                    )
                }
            }
        }

        return result
    }

    fun renderPredictions(cursorOffset: Int, insertedText: String): Boolean {
        val predicted = predictAdditionalEdits(cursorOffset, insertedText).sortedBy { it.priority }
        if (predicted.isEmpty()) return false
        suggestions.clear()
        suggestions.addAll(predicted)
        currentSuggestionIdx = 0
        renderCurrentGhost()
        val filePath = editor.virtualFile?.path ?: ""
        TabFeedback.getInstance().recordSuggest(
            project,
            filePath,
            0,
            predicted.sumOf { it.text.length },
        )
        return true
    }

    private fun renderCurrentGhost() {
        clearGhosts()
        if (currentSuggestionIdx >= suggestions.size) return
        val suggestion = suggestions[currentSuggestionIdx]

        ApplicationManager.getApplication().invokeLater {
            if (editor.isDisposed) return@invokeLater
            val inlayModel = editor.inlayModel
            val properties =
                InlayProperties()
                    .relatesToPrecedingText(true)
                    .disableSoftWrapping(true)
            val inlay =
                inlayModel.addInlineElement(
                    suggestion.offset,
                    properties,
                    GhostInlayRenderer(suggestion.text, editor),
                )
            if (inlay != null) {
                ghostInlays.add(inlay)
            }
        }
    }

    fun acceptCurrent(): Boolean {
        if (currentSuggestionIdx >= suggestions.size) return false
        val suggestion = suggestions[currentSuggestionIdx]
        ApplicationManager.getApplication().invokeLater {
            if (editor.isDisposed) return@invokeLater
            WriteCommandAction.runWriteCommandAction(project, "CodePilot Tab", null, {
                editor.document.insertString(suggestion.offset, suggestion.text)
                editor.caretModel.moveToOffset(suggestion.cursorAfter.coerceIn(0, editor.document.textLength))
            })
            TabFeedback.getInstance().recordAccept(project, editor.virtualFile?.path ?: "", suggestion.text.length)
            currentSuggestionIdx++
            if (currentSuggestionIdx < suggestions.size) {
                renderCurrentGhost()
            } else {
                clearGhosts()
            }
        }
        return true
    }

    fun dismissAndConsume(): Boolean {
        if (!hasActiveSuggestions()) return false
        dismiss()
        return true
    }

    fun dismiss() {
        clearGhosts()
        suggestions.clear()
        currentSuggestionIdx = 0
        TabFeedback.getInstance().recordDismiss(project, "codepilot-tab-dismiss")
    }

    fun hasActiveSuggestions(): Boolean = currentSuggestionIdx < suggestions.size

    private fun clearGhosts() {
        ApplicationManager.getApplication().invokeLater {
            ghostInlays.forEach { inlay ->
                if (inlay.isValid) Disposer.dispose(inlay)
            }
            ghostInlays.clear()
        }
    }

    private class GhostInlayRenderer(
        private val text: String,
        private val editor: Editor,
    ) : com.intellij.openapi.editor.EditorCustomElementRenderer {

        override fun paint(
            inlay: Inlay<*>,
            g: java.awt.Graphics,
            targetRegion: java.awt.Rectangle,
            textAttributes: TextAttributes,
        ) {
            g.color = java.awt.Color(150, 150, 150)
            g.font = editor.contentComponent.font
            val fm = editor.contentComponent.getFontMetrics(g.font)
            text.lines().forEachIndexed { idx, line ->
                g.drawString(line, targetRegion.x, targetRegion.y + fm.ascent + idx * editor.lineHeight)
            }
        }

        override fun calcHeightInPixels(inlay: Inlay<*>): Int =
            editor.lineHeight * text.lines().size.coerceAtLeast(1)

        override fun getContextMenuGroupId(inlay: Inlay<*>): String? = null

        override fun calcWidthInPixels(inlay: Inlay<*>): Int {
            val fm = editor.contentComponent.getFontMetrics(editor.contentComponent.font)
            return text.lines().maxOfOrNull { fm.stringWidth(it) } ?: 0
        }
    }
}
