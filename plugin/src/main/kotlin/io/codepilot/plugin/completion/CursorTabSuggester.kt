package io.codepilot.plugin.completion

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.InlayModel
import com.intellij.openapi.editor.InlayProperties
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * Cursor Tab Multi-Position Suggester.
 *
 * After a completion is accepted, predicts additional positions in the document
 * that likely need modification and pre-renders gray ghost suggestions.
 * User presses Tab to accept each suggestion in sequence (Tab-through).
 *
 * Design inspired by Cursor Tab: detects patterns like:
 * - Closing brackets/braces after new block insertion
 * - Import statements needed after new type reference
 * - Matching method parameter updates
 * - Sibling property additions in data structures
 */
class CursorTabSuggester(private val project: Project, private val editor: Editor) {

    data class GhostSuggestion(
        val id: String = "tab-${System.nanoTime()}",
        val offset: Int,
        val text: String,
        val source: String, // "bracket", "import", "sibling", "parameter"
        val priority: Int,  // Lower = higher priority, Tab-through order
        val cursorAfter: Int = offset + text.length,
    )

    private val ghostInlays = mutableListOf<Inlay<*>>()
    private val suggestions = mutableListOf<GhostSuggestion>()
    private var currentSuggestionIdx = 0

    // Track recent edits for pattern detection
    private val recentEdits = java.util.concurrent.ConcurrentLinkedDeque<EditRecord>()
    private val MAX_RECENT_EDITS = 20

    /** Disposable for registering document listeners and inlays. */
    private val disposable = Disposer.newDisposable("CursorTabSuggester")

    data class EditRecord(
        val offset: Int,
        val oldText: String,
        val newText: String,
        val timestamp: Long,
    )

    companion object {
        private val instances = ConcurrentHashMap<String, CursorTabSuggester>()

        fun getInstance(project: Project, editor: Editor): CursorTabSuggester {
            val key = "${project.basePath}:${editor.document.hashCode()}"
            return instances.getOrPut(key) { CursorTabSuggester(project, editor) }
        }

        // Patterns that trigger bracket completion
        private val BLOCK_OPEN = Regex("""\{\s*$""")
        private val PAREN_OPEN = Regex("""\(\s*$""")
        private val BRACKET_OPEN = Regex("""\[\s*$""")

        // Patterns that suggest import additions
        private val NEW_TYPE_USAGE = Regex("""(?:new\s+|extends\s+|implements\s+|:\s*)([A-Z]\w+)""")

        // Patterns for sibling property additions (trailing comma → next property)
        private val SIBLING_PROPERTY = Regex(""",\s*$""")
    }

    init {
        // Listen to document changes to detect edit patterns
        editor.document.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                recordEdit(event)
                // Clear stale ghost suggestions on any edit
                if (event.newFragment.isNotEmpty() || event.oldFragment.isNotEmpty()) {
                    clearGhosts()
                    // After a brief delay, re-predict based on the edit
                    scheduleRepredict(event)
                }
            }
        }, disposable)
    }

    private fun recordEdit(event: DocumentEvent) {
        recentEdits.addLast(EditRecord(
            offset = event.offset,
            oldText = event.oldFragment.toString(),
            newText = event.newFragment.toString(),
            timestamp = System.currentTimeMillis(),
        ))
        while (recentEdits.size > MAX_RECENT_EDITS) recentEdits.removeFirst()
    }

    private fun scheduleRepredict(event: DocumentEvent) {
        // Only predict after insertions (not deletions)
        if (event.newFragment.isEmpty()) return
        val inserted = event.newFragment.toString()
        val offset = event.offset + inserted.length

        ApplicationManager.getApplication().invokeLater {
            if (editor.isDisposed) return@invokeLater
            val newSuggestions = predictAdditionalEdits(offset, inserted)
            if (newSuggestions.isNotEmpty()) {
                suggestions.clear()
                suggestions.addAll(newSuggestions.sortedBy { it.priority })
                currentSuggestionIdx = 0
                renderCurrentGhost()
            }
        }
    }

    /**
     * After user types/accepts text at [offset], predict additional edits needed.
     * Returns a prioritized list of ghost suggestions.
     */
    fun predictAdditionalEdits(cursorOffset: Int, insertedText: String): List<GhostSuggestion> {
        val result = mutableListOf<GhostSuggestion>()
        val doc = editor.document.text
        val lineNumber = editor.document.getLineNumber(cursorOffset)
        val lineStart = editor.document.getLineStartOffset(lineNumber)
        val lineEnd = editor.document.getLineEndOffset(lineNumber)
        val currentLine = doc.substring(lineStart, minOf(lineEnd, doc.length))

        // 1. Bracket completion: if we just opened a block, suggest closing
        if (BLOCK_OPEN.containsMatchIn(insertedText) || BLOCK_OPEN.containsMatchIn(currentLine)) {
            val indent = currentLine.takeWhile { it == ' ' || it == '\t' }
            val baseIndent = if (indent.length >= 4) indent.dropLast(4) else ""
            // Find if closing brace already exists
            val nextNonBlank = doc.substring(cursorOffset).dropWhile { it == ' ' || it == '\t' || it == '\n' || it == '\r' }
            if (!nextNonBlank.startsWith("}")) {
                result.add(GhostSuggestion(
                    offset = cursorOffset,
                    text = "\n${indent}}",
                    source = "bracket",
                    priority = 0,
                ))
            }
        }

        // 2. Sibling property: if line ends with comma in object/struct/array, suggest next slot
        if (SIBLING_PROPERTY.containsMatchIn(currentLine) && currentLine.contains(":")) {
            val keyPattern = Regex("""(\w+)\s*:""")
            val lastKey = keyPattern.findAll(currentLine).lastOrNull()?.groupValues?.get(1)
            if (lastKey != null) {
                val indent = currentLine.takeWhile { it == ' ' || it == '\t' }
                result.add(GhostSuggestion(
                    offset = cursorOffset,
                    text = "\n${indent}key: value",
                    source = "sibling",
                    priority = 2,
                ))
            }
        }

        // 3. Import suggestion: detect new type usage that may need import
        val typeMatches = NEW_TYPE_USAGE.findAll(insertedText)
        for (match in typeMatches) {
            val typeName = match.groupValues[1]
            // Check if import already exists in the file
            val importPattern = Regex("""import\s+.*\b$typeName\b""")
            if (!importPattern.containsMatchIn(doc)) {
                // Find the first import line to suggest insertion point
                val firstImport = doc.lines().indexOfFirst { it.startsWith("import ") }
                if (firstImport >= 0) {
                    val importOffset = editor.document.getLineStartOffset(firstImport)
                    result.add(GhostSuggestion(
                        offset = importOffset,
                        text = "import $typeName;\n",
                        source = "import",
                        priority = 1,
                    ))
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

    /**
     * Render the current ghost suggestion as a gray inline inlay.
     */
    private fun renderCurrentGhost() {
        clearGhosts()
        if (currentSuggestionIdx >= suggestions.size) return
        val suggestion = suggestions[currentSuggestionIdx]

        ApplicationManager.getApplication().invokeLater {
            if (editor.isDisposed) return@invokeLater
            val inlayModel = editor.inlayModel
            val properties = InlayProperties()
                .relatesToPrecedingText(true)
                .disableSoftWrapping(true)
            val inlay = inlayModel.addInlineElement(
                suggestion.offset,
                properties,
                GhostInlayRenderer(suggestion.text, editor),
            )
            if (inlay != null) {
                ghostInlays.add(inlay)
            }
        }
    }

    /**
     * Accept the current ghost suggestion (Tab key handler).
     * Inserts the suggestion text and moves to the next one.
     */
    fun acceptCurrent(): Boolean {
        if (currentSuggestionIdx >= suggestions.size) return false
        val suggestion = suggestions[currentSuggestionIdx]
        ApplicationManager.getApplication().invokeLater {
            if (editor.isDisposed) return@invokeLater
            WriteCommandAction.runWriteCommandAction(project, "CodePilot Tab Prediction", null, {
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

    /**
     * Dismiss all ghost suggestions (Esc key handler).
     */
    fun dismiss() {
        clearGhosts()
        suggestions.clear()
        currentSuggestionIdx = 0
        TabFeedback.getInstance().recordDismiss(project, "cursor-tab-dismiss")
    }

    /**
     * Check if there are active ghost suggestions (for Tab interception).
     */
    fun hasActiveSuggestions(): Boolean = currentSuggestionIdx < suggestions.size

    private fun clearGhosts() {
        ApplicationManager.getApplication().invokeLater {
            ghostInlays.forEach { inlay ->
                if (inlay.isValid) Disposer.dispose(inlay)
            }
            ghostInlays.clear()
        }
    }

    /**
     * Custom InlayRenderer for ghost text display.
     * Renders text in gray (ghost) color, similar to inline completion hints.
     */
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
            val color = java.awt.Color(150, 150, 150) // Ghost gray
            g.color = color
            g.font = editor.contentComponent.font
            val fm = editor.contentComponent.getFontMetrics(g.font)
            text.lines().forEachIndexed { idx, line ->
                g.drawString(line, targetRegion.x, targetRegion.y + fm.ascent + idx * editor.lineHeight)
            }
        }

        override fun calcHeightInPixels(inlay: Inlay<*>): Int {
            return editor.lineHeight * text.lines().size.coerceAtLeast(1)
        }

        override fun getContextMenuGroupId(inlay: Inlay<*>): String? = null

        override fun calcWidthInPixels(inlay: Inlay<*>): Int {
            val fm = editor.contentComponent.getFontMetrics(editor.contentComponent.font)
            return text.lines().maxOfOrNull { fm.stringWidth(it) } ?: 0
        }

        override fun toString(): String = "GhostInlayRenderer($text)"
    }
}