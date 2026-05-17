package io.codepilot.plugin.inline

import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.markup.TextAttributes
import java.awt.Color
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Rectangle
import java.awt.RenderingHints

/**
 * Block inlay renderer used by [InlineEditController] to show the proposed
 * replacement text directly below the user's selection. We use a renderer (no
 * embedded Swing controls) to keep the integration simple; Accept/Reject/Rewrite
 * are bound to `Alt+Y / Alt+N / Alt+R` actions instead of click handlers.
 *
 * The renderer reads [InlineEditSession.proposedBuffer] on every paint, so streaming
 * deltas appear without re-creating the inlay — callers just call
 * `inlay.repaint(inlay.bounds)` after each delta append.
 */
class InlineDiffInlayRenderer(
    private val session: InlineEditSession,
) : EditorCustomElementRenderer {
    private val padTop = 4
    private val padLeft = 8
    private val barHeight = 22

    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        // Fill the visible width so the green band is obvious.
        val w = inlay.editor.scrollingModel.visibleArea.width
        return if (w > 0) w else 800
    }

    override fun calcHeightInPixels(inlay: Inlay<*>): Int {
        val lines = session.proposedText.lines().size.coerceAtLeast(1)
        return lines * inlay.editor.lineHeight + barHeight + padTop * 2
    }

    override fun paint(inlay: Inlay<*>, g: Graphics, region: Rectangle, attrs: TextAttributes) {
        val ed = inlay.editor
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)

        val bodyHeight = region.height - barHeight
        // Green band background
        g2.color = Color(80, 200, 120, 36)
        g2.fillRect(region.x, region.y, region.width, bodyHeight)
        g2.color = Color(80, 200, 120, 110)
        g2.drawLine(region.x, region.y, region.x + region.width, region.y)

        // Proposed text, "+" sigil
        g2.color = Color(40, 140, 80)
        g2.font = ed.colorsScheme.getFont(EditorFontType.PLAIN)
        val lh = ed.lineHeight
        val baseY = region.y + padTop + lh - 4
        session.proposedText.split('\n').forEachIndexed { i, line ->
            g2.drawString("+ $line", region.x + padLeft, baseY + i * lh)
        }

        // Action bar at the bottom
        val barY = region.y + region.height - barHeight
        g2.color = Color(45, 45, 50)
        g2.fillRect(region.x, barY, region.width, barHeight)
        g2.color = Color(220, 220, 220)
        val label = when (session.status) {
            InlineEditSession.Status.STREAMING -> "Generating…  (Esc to cancel)"
            InlineEditSession.Status.READY -> "Alt+Y Accept · Alt+N Reject · Alt+R Rewrite"
            InlineEditSession.Status.ACCEPTED -> "Accepted"
            InlineEditSession.Status.REJECTED -> "Rejected"
            InlineEditSession.Status.FAILED -> "Failed — Alt+N to dismiss"
        }
        g2.drawString(label, region.x + padLeft, barY + barHeight - 6)
    }
}
