package io.codepilot.plugin.inline

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.markup.RangeHighlighter

/**
 * P0-04 — one live inline-edit session per editor. Held by [InlineEditController]
 * and consumed by [AcceptInlineAction] / [RejectInlineAction] / [RewriteInlineAction]
 * so they can decide whether they are enabled at all.
 */
data class InlineEditSession(
    val turnId: String,
    val editor: Editor,
    val filePath: String,
    val startOffset: Int,
    val endOffset: Int,
    /** Snapshot of the original selection. */
    val originalText: String,
    /** Streaming buffer for the LLM-produced replacement. */
    val proposedBuffer: StringBuilder = StringBuilder(),
    var highlighter: RangeHighlighter? = null,
    var inlay: Inlay<InlineDiffInlayRenderer>? = null,
    var status: Status = Status.STREAMING,
) {
    enum class Status { STREAMING, READY, ACCEPTED, REJECTED, FAILED }

    val proposedText: String get() = proposedBuffer.toString()
}
