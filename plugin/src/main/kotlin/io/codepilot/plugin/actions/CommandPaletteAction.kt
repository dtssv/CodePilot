package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.DefaultListModel
import com.intellij.ui.components.JBTextField
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Open the CodePilot command palette (Ctrl+Shift+P).
 *
 * Shows a searchable popup with available CodePilot commands:
 * - New Chat, Open Chat, Toggle Agent Mode
 * - Refactor, Review, Comment, GenTest, GenDoc
 * - Inline Edit (Ctrl+K), Bug Scan
 * - Accept/Dismiss Completion
 */
class CommandPaletteAction : AnAction("Command Palette", "Open CodePilot command palette", null) {

    private data class Command(
        val name: String,
        val actionId: String,
        val shortcut: String = "",
    )

    private val commands = listOf(
        Command("New Chat", "CodePilot.NewChat", "Ctrl+Shift+L"),
        Command("Open Chat", "CodePilot.OpenChat", "Ctrl+L"),
        Command("Toggle Agent Mode", "CodePilot.ToggleAgent", "Ctrl+I"),
        Command("Inline Edit", "CodePilot.InlineEdit", "Ctrl+K"),
        Command("Inline Completion", "CodePilot.InlineCompletion", "Ctrl+Shift+J"),
        Command("Accept Completion", "CodePilot.AcceptCompletion", "Ctrl+Shift+K"),
        Command("Dismiss Completion", "CodePilot.DismissCompletion", "Esc"),
        Command("Send Message", "CodePilot.SendMessage", "Ctrl+Enter"),
    )

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        showPalette(project, e)
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
    }

    private fun showPalette(project: Project, e: AnActionEvent) {
        val searchField = JBTextField().apply {
            preferredSize = Dimension(350, 28)
            emptyText.text = "Search CodePilot commands..."
        }

        val model = DefaultListModel<Command>()
        commands.forEach { model.addElement(it) }

        val list = JBList(model).apply {
            cellRenderer = CommandListCellRenderer()
        }

        val panel = JPanel(BorderLayout()).apply {
            add(searchField, BorderLayout.NORTH)
            add(JBScrollPane(list).apply {
                preferredSize = Dimension(350, 200)
            }, BorderLayout.CENTER)
        }

        // Filter on type
        searchField.addKeyListener(object : KeyAdapter() {
            override fun keyReleased(e: KeyEvent) {
                val query = searchField.text.lowercase()
                model.clear()
                commands.filter { it.name.lowercase().contains(query) }
                    .forEach { model.addElement(it) }
                if (model.size() > 0) list.selectedIndex = 0
            }
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_DOWN -> {
                        if (list.selectedIndex < model.size() - 1) list.selectedIndex++
                        e.consume()
                    }
                    KeyEvent.VK_UP -> {
                        if (list.selectedIndex > 0) list.selectedIndex--
                        e.consume()
                    }
                    KeyEvent.VK_ENTER -> {
                        executeSelected(project, list, e)
                        e.consume()
                    }
                    KeyEvent.VK_ESCAPE -> {
                        closePopup(searchField)
                        e.consume()
                    }
                }
            }
        })

        list.addListSelectionListener {
            // Double-click to execute
        }

        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, searchField)
            .setTitle("CodePilot Commands")
            .setMovable(false)
            .setResizable(false)
            .setRequestFocus(true)
            .setFocusOwners(arrayOf(searchField))
            .setCancelOnWindowDeactivation(true)
            .createPopup()

        popup.showInFocusCenter()
    }

    private fun executeSelected(project: Project, list: JBList<Command>, e: KeyEvent) {
        val cmd = list.selectedValue ?: return
        val am = com.intellij.openapi.actionSystem.ActionManager.getInstance()
        val action = am.getAction(cmd.actionId)
        if (action != null) {
            val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromAnAction(
                action, null, "CodePilotCommandPalette",
                com.intellij.openapi.actionSystem.DataContext.EMPTY_CONTEXT,
            )
            action.actionPerformed(event)
        }
        closePopup(e.component as JBTextField)
    }

    private fun closePopup(field: JBTextField) {
        SwingUtilities.getRootPane(field)?.let { root ->
            SwingUtilities.getWindowAncestor(root)?.dispose()
        }
    }

    private class CommandListCellRenderer : javax.swing.ListCellRenderer<Command> {
        private val label = javax.swing.JLabel()
        override fun getListCellRendererComponent(
            list: javax.swing.JList<out Command>?,
            value: Command?,
            index: Int,
            selected: Boolean,
            cellHasFocus: Boolean,
        ): java.awt.Component {
            label.text = if (value?.shortcut?.isNotEmpty() == true) {
                "${value.name}  (${value.shortcut})"
            } else {
                value?.name ?: ""
            }
            label.isOpaque = true
            label.background = if (selected) com.intellij.ui.JBColor.BLUE.darker() else list?.background
            label.foreground = if (selected) java.awt.Color.WHITE else list?.foreground
            return label
        }
    }
}