package io.codepilot.plugin.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.colors.EditorColors
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent

/**
 * InlineDiffRenderer — Renders inline edit diffs with accept/reject interaction.
 *
 * Features:
 * - Green/red highlighting for added/removed text
 * - Tab to accept, Esc to reject
 * - Multi-hunk diff support
 * - Automatic cleanup of highlighters and listeners
 */
class InlineDiffRenderer(
    private val project: Project,
    private val editor: Editor,
) {

    private val log = logger<InlineDiffRenderer>()

    private val highlighters = mutableListOf<RangeHighlighter>()
    private var activeListener: KeyAdapter? = null
    private var isApplied = false

    // Colors for diff highlighting
    private val addedAttributes = TextAttributes().apply {
        backgroundColor = JBColor(java.awt.Color(0x28, 0x8B, 0x53, 0x40), java.awt.Color(0x28, 0x8B, 0x53, 0x30))
        effectColor = JBColor(java.awt.Color(0x28, 0x8B, 0x53), java.awt.Color(0x28, 0x8B, 0x53))
        effectType = com.intellij.openapi.editor.markup.EffectType.LINE_UNDERSCORE
    }

    private val removedAttributes = TextAttributes().apply {
        backgroundColor = JBColor(java.awt.Color(0xE0, 0x4C, 0x4C, 0x30), java.awt.Color(0xE0, 0x4C, 0x4C, 0x20))
        effectColor = JBColor(java.awt.Color(0xE0, 0x4C, 0x4C), java.awt.Color(0xE0, 0x4C, 0x4C))
        effectType = com.intellij.openapi.editor.markup.EffectType.STRIKEOUT
    }

    private val pendingAttributes = TextAttributes().apply {
        backgroundColor = JBColor(java.awt.Color(0x44, 0x72, 0xC4, 0x30), java.awt.Color(0x44, 0x72, 0xC4, 0x20))
        effectColor = JBColor(java.awt.Color(0x44, 0x72, 0xC4), java.awt.Color(0x44, 0x72, 0xC4))
        effectType = com.intellij.openapi.editor.markup.EffectType.LINE_UNDERSCORE
    }

    data class DiffHunk(
        val startOffset: Int,
        val endOffset: Int,
        val originalText: String,
        val newText: String,
    )

    /**
     * Apply a single replacement with diff preview and accept/reject interaction.
     * @param startOffset Start offset of the original text
     * @param endOffset End offset of the original text
     * @param originalText The original text (for undo on reject)
     * @param newText The replacement text
     * @param onAccept Optional callback when user accepts (Tab)
     * @param onReject Optional callback when user rejects (Esc)
     */
    fun applyWithDiff(
        startOffset: Int,
        endOffset: Int,
        originalText: String,
        newText: String,
        onAccept: () -> Unit = {},
        onReject: () -> Unit = {},
    ) {
        val cleanedCode = cleanCode(newText)
        if (cleanedCode == originalText) return

        // Apply the replacement
        WriteCommandAction.runWriteCommandAction(project) {
            editor.document.replaceString(startOffset, endOffset, cleanedCode)
        }

        val newEndOffset = startOffset + cleanedCode.length

        // Add green highlight for the new text
        val highlighter = editor.markupModel.addRangeHighlighter(
            startOffset, newEndOffset,
            HighlighterLayer.SELECTION,
            addedAttributes,
            HighlighterTargetArea.EXACT_RANGE,
        )
        highlighters.add(highlighter)

        // Install Tab/Esc listener
        installAcceptRejectListener(startOffset, cleanedCode, originalText, onAccept, onReject)
    }

    /**
     * Apply multiple diff hunks with diff preview and accept/reject interaction.
     * @param hunks List of DiffHunk objects (must be sorted by startOffset ascending)
     * @param onAccept Optional callback when all hunks are accepted
     * @param onReject Optional callback when all hunks are rejected
     */
    fun applyMultipleHunks(
        hunks: List<DiffHunk>,
        onAccept: () -> Unit = {},
        onReject: () -> Unit = {},
    ) {
        if (hunks.isEmpty()) return

        // Apply hunks in reverse order to preserve offsets
        val sorted = hunks.sortedByDescending { it.startOffset }
        val appliedHunks = mutableListOf<AppliedHunk>()

        WriteCommandAction.runWriteCommandAction(project) {
            for (hunk in sorted) {
                val cleaned = cleanCode(hunk.newText)
                editor.document.replaceString(hunk.startOffset, hunk.endOffset, cleaned)
                appliedHunks.add(AppliedHunk(
                    hunk.startOffset,
                    hunk.startOffset + cleaned.length,
                    hunk.originalText,
                    cleaned,
                ))
            }
        }

        // Add highlighters for each applied hunk
        for (hunk in appliedHunks) {
            val highlighter = editor.markupModel.addRangeHighlighter(
                hunk.newStartOffset, hunk.newEndOffset,
                HighlighterLayer.SELECTION,
                addedAttributes,
                HighlighterTargetArea.EXACT_RANGE,
            )
            highlighters.add(highlighter)
        }

        // Install single listener for all hunks
        installMultiHunkAcceptRejectListener(appliedHunks, onAccept, onReject)
    }

    /**
     * Show a "pending edit" highlight while the backend is processing.
     */
    fun showPendingHighlight(startOffset: Int, endOffset: Int): RangeHighlighter {
        val highlighter = editor.markupModel.addRangeHighlighter(
            startOffset, endOffset,
            HighlighterLayer.SELECTION - 1,
            pendingAttributes,
            HighlighterTargetArea.EXACT_RANGE,
        )
        highlighters.add(highlighter)
        return highlighter
    }

    /**
     * Remove all highlighters and listeners.
     */
    fun cleanup() {
        highlighters.forEach { editor.markupModel.removeHighlighter(it) }
        highlighters.clear()
        activeListener?.let { editor.contentComponent.removeKeyListener(it) }
        activeListener = null
    }

    /**
     * Force accept (programmatic, not user-triggered).
     */
    fun forceAccept() {
        cleanup()
        isApplied = true
    }

    /**
     * Force reject (programmatic undo).
     */
    fun forceReject(originalText: String, startOffset: Int, endOffset: Int) {
        cleanup()
        WriteCommandAction.runWriteCommandAction(project) {
            editor.document.replaceString(startOffset, endOffset, originalText)
        }
        isApplied = false
    }

    private data class AppliedHunk(
        val newStartOffset: Int,
        val newEndOffset: Int,
        val originalText: String,
        val newText: String,
    )

    private fun installAcceptRejectListener(
        startOffset: Int,
        newText: String,
        originalText: String,
        onAccept: () -> Unit,
        onReject: () -> Unit,
    ) {
        val listener = object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_TAB -> {
                        cleanup()
                        isApplied = true
                        onAccept()
                        e.consume()
                    }
                    KeyEvent.VK_ESCAPE -> {
                        // Reject: undo the replacement
                        WriteCommandAction.runWriteCommandAction(project) {
                            val currentEnd = startOffset + newText.length
                            editor.document.replaceString(startOffset, currentEnd, originalText)
                        }
                        cleanup()
                        isApplied = false
                        onReject()
                        e.consume()
                    }
                }
            }
        }
        editor.contentComponent.addKeyListener(listener)
        activeListener = listener
    }

    private fun installMultiHunkAcceptRejectListener(
        appliedHunks: List<AppliedHunk>,
        onAccept: () -> Unit,
        onReject: () -> Unit,
    ) {
        val listener = object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_TAB -> {
                        cleanup()
                        isApplied = true
                        onAccept()
                        e.consume()
                    }
                    KeyEvent.VK_ESCAPE -> {
                        // Reject: undo all hunks in reverse order
                        WriteCommandAction.runWriteCommandAction(project) {
                            for (hunk in appliedHunks.sortedByDescending { it.newStartOffset }) {
                                editor.document.replaceString(
                                    hunk.newStartOffset,
                                    hunk.newEndOffset,
                                    hunk.originalText,
                                )
                            }
                        }
                        cleanup()
                        isApplied = false
                        onReject()
                        e.consume()
                    }
                }
            }
        }
        editor.contentComponent.addKeyListener(listener)
        activeListener = listener
    }

    companion object {
        /**
         * Clean up LLM output: strip markdown fences, surrounding quotes, etc.
         */
        fun cleanCode(raw: String): String {
            return raw
                .trim()
                .removeSurrounding("\"")
                .replace(Regex("^```\\w*\\n"), "")
                .removeSuffix("```")
                .trim()
        }
    }
}