package io.codepilot.plugin.actions

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.Presentation
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import java.awt.Cursor
import java.awt.FlowLayout
import java.awt.Point
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BorderFactory
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JWindow
import javax.swing.SwingUtilities

object CodePilotSelectionHint {

    private var popupWindow: JWindow? = null
    private var currentEditor: Editor? = null
    private var selectionListenerDisposable: Disposable? = null

    fun install(editor: Editor, project: Project) {
        uninstall()
        currentEditor = editor
        val disposable = Disposer.newDisposable("CodePilotSelectionHint")
        selectionListenerDisposable = disposable
        editor.selectionModel.addSelectionListener(object : SelectionListener {
            override fun selectionChanged(e: SelectionEvent) {
                if (editor.selectionModel.selectedText.isNullOrBlank()) {
                    hidePopup()
                } else {
                    showPopup(editor, project)
                }
            }
        }, disposable)
    }

    fun uninstall() {
        hidePopup()
        selectionListenerDisposable?.let { Disposer.dispose(it) }
        selectionListenerDisposable = null
        currentEditor = null
    }

    private fun showPopup(editor: Editor, project: Project) {
        SwingUtilities.invokeLater {
            hidePopup()
            val contentComponent = editor.contentComponent
            val parent = SwingUtilities.getWindowAncestor(contentComponent) ?: return@invokeLater

            val panel = JPanel(FlowLayout(FlowLayout.LEFT, 4, 2)).apply {
                isOpaque = true
                background = JBColor.background()
                border = BorderFactory.createCompoundBorder(
                    BorderFactory.createLineBorder(JBColor.border(), 1),
                    BorderFactory.createEmptyBorder(2, 6, 2, 6)
                )
            }

            val addLabel = JLabel("Add to Chat").apply {
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                foreground = JBColor.foreground()
                toolTipText = "Add selected code to current chat (Ctrl+L)"
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent?) {
                        hidePopup()
                        AddToChatAction().actionPerformed(makeEvent(project, editor))
                    }
                })
            }

            val newLabel = JLabel("New Chat").apply {
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                foreground = JBColor.foreground()
                toolTipText = "Add selected code to a new chat"
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent?) {
                        hidePopup()
                        AddToNewChatAction().actionPerformed(makeEvent(project, editor))
                    }
                })
            }

            panel.add(addLabel)
            panel.add(JLabel("|").apply { foreground = JBColor.GRAY })
            panel.add(newLabel)

            val window = JWindow(parent).apply {
                isAlwaysOnTop = true
                add(panel)
                pack()
            }

            val selModel = editor.selectionModel
            val visualStart = editor.offsetToXY(selModel.selectionStart)
            val visualEnd = editor.offsetToXY(selModel.selectionEnd)
            val contentRect = contentComponent.visibleRect

            val px = contentRect.x + contentRect.width - window.width - 10
            val py = if (visualStart.y > window.height + 5) {
                visualStart.y - window.height - 2
            } else {
                visualEnd.y + editor.lineHeight + 2
            }

            val point = Point(px, py)
            SwingUtilities.convertPointToScreen(point, contentComponent)
            window.location = point
            popupWindow = window
            window.isVisible = true
        }
    }

    private fun hidePopup() {
        popupWindow?.let { it.isVisible = false; it.dispose() }
        popupWindow = null
    }

    private fun makeEvent(project: Project, editor: Editor): AnActionEvent {
        return object : AnActionEvent(
            null,
            DataContext { dataId ->
                when (dataId) {
                    CommonDataKeys.PROJECT.name -> project
                    CommonDataKeys.EDITOR.name -> editor
                    CommonDataKeys.PSI_FILE.name ->
                        com.intellij.psi.PsiDocumentManager.getInstance(project)
                            .getPsiFile(editor.document)
                    else -> null
                }
            },
            "CodePilotSelectionHint",
            Presentation(),
            ActionManager.getInstance(),
            0,
        ) {}
    }
}