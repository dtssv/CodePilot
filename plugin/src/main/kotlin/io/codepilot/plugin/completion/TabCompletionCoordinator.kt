package io.codepilot.plugin.completion

import com.intellij.openapi.editor.Editor
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Coordinates inline completion (platform gray text) vs CodePilot Tab ghost inlays so they do
 * not both call the backend or paint at the caret at the same time.
 */
object TabCompletionCoordinator {
    private val inlineActive = ConcurrentHashMap<String, Boolean>()
    private val tabPredictGeneration = ConcurrentHashMap<String, AtomicLong>()

    private fun editorKey(editor: Editor): String =
        "${editor.project?.basePath}:${editor.document.hashCode()}"

    fun setInlineActive(
        editor: Editor,
        active: Boolean,
    ) {
        inlineActive[editorKey(editor)] = active
    }

    fun isInlineActive(editor: Editor): Boolean = inlineActive[editorKey(editor)] == true

    /** Bump generation so in-flight tab/predict responses from typing are ignored. */
    fun bumpTabPredictGeneration(editor: Editor): Long {
        val gen = tabPredictGeneration.getOrPut(editorKey(editor)) { AtomicLong(0) }
        return gen.incrementAndGet()
    }

    fun isStaleTabPredict(
        editor: Editor,
        generation: Long,
    ): Boolean {
        val current = tabPredictGeneration[editorKey(editor)]?.get() ?: 0L
        return generation != current
    }

    fun clear(editor: Editor) {
        val key = editorKey(editor)
        inlineActive.remove(key)
        tabPredictGeneration.remove(key)
    }
}
