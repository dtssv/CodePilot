package io.codepilot.plugin.hooks

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import io.codepilot.plugin.i18n.CodePilotBundle
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * Swing UI for editing [HookEngine] rules. Same persistence as WebUI **Integrations → MCP → hooks**
 * (`.codepilot/hooks.json`), so tool-window users are not forced into JCEF to configure hooks.
 */
class HookConfigPanel(
    private val project: Project,
) {
    private val engine = HookEngine.getInstance(project)
    private val listHost =
        JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
        }
    private val rowModels = mutableListOf<RowModel>()

    private data class RowModel(
        val id: String,
        val event: JBTextField,
        val command: JBTextField,
        val enabled: JCheckBox,
        val timeout: JBTextField,
        val wrapper: JPanel,
    )

    val component: JComponent =
        JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(8)
            add(
                JLabel("<html>${CodePilotBundle.message("mcpPanel.hooksIntro")}</html>"),
                BorderLayout.NORTH,
            )
            add(JBScrollPane(listHost), BorderLayout.CENTER)
            val bar = JPanel(FlowLayout(FlowLayout.LEFT, 8, 4))
            bar.add(
                JButton(CodePilotBundle.message("mcpPanel.hooksAdd")).apply {
                    addActionListener { addEmptyRow() }
                },
            )
            bar.add(
                JButton(CodePilotBundle.message("mcpPanel.hooksSave")).apply {
                    addActionListener { save() }
                },
            )
            add(bar, BorderLayout.SOUTH)
            loadFromEngine()
        }

    private fun loadFromEngine() {
        listHost.removeAll()
        rowModels.clear()
        for (h in engine.list()) {
            addRow(h.id, h.event, h.command, h.enabled, h.timeoutMs)
        }
        if (rowModels.isEmpty()) {
            addEmptyRow()
        }
        listHost.revalidate()
        listHost.repaint()
    }

    private fun addEmptyRow() {
        addRow("hook-${System.currentTimeMillis()}", "beforeSubmitPrompt", "echo \"{{message}}\"", true, 30_000)
    }

    private fun addRow(
        id: String,
        event: String,
        command: String,
        enabled: Boolean,
        timeoutMs: Int,
    ) {
        val eventF = JBTextField(event, 14)
        val cmdF = JBTextField(command, 40)
        val enCb = JCheckBox(CodePilotBundle.message("mcpPanel.hooksEnabled"), enabled)
        val toF = JBTextField(timeoutMs.toString(), 5)
        val row = JPanel(BorderLayout(4, 4))
        val inner = JPanel(FlowLayout(FlowLayout.LEFT, 6, 2))
        inner.add(JLabel(CodePilotBundle.message("mcpPanel.hooksEvent")))
        inner.add(eventF)
        inner.add(JLabel(CodePilotBundle.message("mcpPanel.hooksCommand")))
        inner.add(cmdF)
        inner.add(enCb)
        inner.add(JLabel(CodePilotBundle.message("mcpPanel.hooksTimeoutMs")))
        inner.add(toF)
        row.add(inner, BorderLayout.CENTER)
        row.add(
            JButton(CodePilotBundle.message("mcpPanel.hooksRemove")).apply {
                addActionListener {
                    listHost.remove(row)
                    rowModels.removeIf { it.wrapper === row }
                    listHost.revalidate()
                    listHost.repaint()
                }
            },
            BorderLayout.EAST,
        )
        listHost.add(row)
        rowModels.add(RowModel(id, eventF, cmdF, enCb, toF, row))
    }

    private fun save() {
        val hooks =
            rowModels.mapNotNull { r ->
                val cmd = r.command.text.trim()
                if (cmd.isEmpty()) return@mapNotNull null
                val to = r.timeout.text.trim().toIntOrNull()?.coerceIn(1_000, 300_000) ?: 30_000
                HookEngine.Hook(
                    id = r.id.ifBlank { "hook-${System.currentTimeMillis()}" },
                    event = r.event.text.trim().ifEmpty { "beforeSubmitPrompt" },
                    command = cmd,
                    enabled = r.enabled.isSelected,
                    timeoutMs = to,
                )
            }
        engine.writeHooks(hooks)
        Messages.showInfoMessage(
            project,
            CodePilotBundle.message("mcpPanel.hooksSaved"),
            CodePilotBundle.message("mcpPanel.tabHooks"),
        )
        loadFromEngine()
    }
}
