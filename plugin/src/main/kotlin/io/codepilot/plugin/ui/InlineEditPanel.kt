package io.codepilot.plugin.ui

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.JBColor
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.BorderFactory
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import com.intellij.ui.components.JBTextField
import javax.swing.SwingUtilities

/**
 * InlineEditPanel — A reusable popup panel for Ctrl+K inline edit instruction input.
 *
 * Features:
 * - Instruction input field with prompt text
 * - Submit (Enter) / Cancel (Esc) keyboard shortcuts
 * - Optional loading spinner state during SSE streaming
 * - Themed to match IntelliJ editor style
 */
class InlineEditPanel(
    private val project: Project,
    private val editor: Editor,
    private val onSubmit: (instruction: String) -> Unit,
    private val onCancel: () -> Unit = {},
) {

    private val log = logger<InlineEditPanel>()

    private val inputField = JBTextField().apply {
        preferredSize = Dimension(420, 32)
        emptyText.text = "Enter instruction (e.g., add null check, extract method)... "
        font = Font("JetBrains Mono", Font.PLAIN, 13)
    }

    private val submitButton = JButton("Edit").apply {
        toolTipText = "Submit instruction (Enter)"
        isOpaque = true
    }

    private val cancelButton = JButton("Cancel").apply {
        toolTipText = "Cancel (Esc)"
        isOpaque = true
    }

    private val statusLabel = JLabel("").apply {
        font = Font("Dialog", Font.PLAIN, 11)
        foreground = JBColor.GRAY
    }

    private val rootPanel = JPanel(BorderLayout(4, 4)).apply {
        border = BorderFactory.createEmptyBorder(4, 8, 4, 8)
        add(inputField, BorderLayout.CENTER)
        add(JPanel(FlowLayout(FlowLayout.RIGHT, 4, 0)).apply {
            add(submitButton)
            add(cancelButton)
        }, BorderLayout.EAST)
        add(statusLabel, BorderLayout.SOUTH)
    }

    private var popup: com.intellij.openapi.ui.popup.LightweightWindowEvent? = null
    private var jbPopup: com.intellij.openapi.ui.popup.JBPopup? = null

    init {
        // Keyboard shortcuts
        inputField.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_ENTER -> submitInstruction()
                    KeyEvent.VK_ESCAPE -> close()
                }
            }
        })

        submitButton.addActionListener { submitInstruction() }
        cancelButton.addActionListener { close() }
    }

    /**
     * Show the popup anchored at the given offset in the editor.
     */
    fun showAtOffset(offset: Int) {
        val visualPosition = editor.offsetToVisualPosition(offset)
        val point = editor.visualPositionToXY(visualPosition)

        jbPopup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(rootPanel, inputField)
            .setTitle("CodePilot Inline Edit")
            .setMovable(false)
            .setResizable(false)
            .setRequestFocus(true)
            .setFocusOwners(arrayOf(inputField))
            .setCancelOnWindowDeactivation(true)
            .createPopup()

        val contentComponent = editor.contentComponent
        SwingUtilities.convertPointToScreen(point, contentComponent)
        jbPopup?.showInScreenCoordinates(editor.contentComponent, point)
    }

    /**
     * Update the status label (e.g., "Generating edit...", "Streaming response...")
     */
    fun setStatus(text: String) {
        SwingUtilities.invokeLater { statusLabel.text = text }
    }

    /**
     * Show loading state — disable input and show spinner text.
     */
    fun setLoading(loading: Boolean) {
        SwingUtilities.invokeLater {
            inputField.isEnabled = !loading
            submitButton.isEnabled = !loading
            if (loading) {
                statusLabel.text = "Generating edit..."
                submitButton.text = "..."
            } else {
                statusLabel.text = ""
                submitButton.text = "Edit"
            }
        }
    }

    /**
     * Close the popup.
     */
    fun close() {
        jbPopup?.cancel()
        onCancel()
    }

    private fun submitInstruction() {
        val instruction = inputField.text.trim()
        if (instruction.isNotEmpty()) {
            jbPopup?.cancel()
            onSubmit(instruction)
        }
    }
}