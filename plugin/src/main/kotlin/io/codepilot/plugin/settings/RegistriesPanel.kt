package io.codepilot.plugin.settings

import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.ToolbarDecorator
import com.intellij.ui.components.JBTextField
import com.intellij.ui.table.JBTable
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.table.DefaultTableModel

/**
 * Settings → Marketplace Registries panel.
 * Allows users to add/edit/delete registry URLs and their public keys.
 */
class RegistriesPanel {
    private val columnNames = arrayOf("Name", "URL", "Public Key (SHA256)")
    private val tableModel = DefaultTableModel(columnNames, 0)
    private val table = JBTable(tableModel)

    val component: JComponent

    init {
        table.setShowGrid(true)
        table.preferredScrollableViewportSize = Dimension(600, 200)

        val decorator =
            ToolbarDecorator
                .createDecorator(table)
                .setAddAction { addRegistry() }
                .setEditAction { editRegistry() }
                .setRemoveAction { removeRegistry() }
                .createPanel()

        component =
            JPanel(BorderLayout()).apply {
                add(JLabel("Marketplace Registries:"), BorderLayout.NORTH)
                add(decorator, BorderLayout.CENTER)
            }

        loadFromSettings()
    }

    fun isModified(): Boolean {
        val settings = CodePilotSettings.getInstance()
        return settings.state.registries != getCurrentRegistries()
    }

    fun apply() {
        val settings = CodePilotSettings.getInstance()
        settings.state.registries = getCurrentRegistries()
    }

    fun reset() {
        loadFromSettings()
    }

    private fun loadFromSettings() {
        val settings = CodePilotSettings.getInstance()
        tableModel.rowCount = 0
        for (reg in settings.state.registries) {
            tableModel.addRow(arrayOf(reg.name, reg.url, reg.publicKeyHash))
        }
    }

    private fun getCurrentRegistries(): List<RegistryEntry> {
        val result = mutableListOf<RegistryEntry>()
        for (i in 0 until tableModel.rowCount) {
            result.add(
                RegistryEntry(
                    name = tableModel.getValueAt(i, 0) as String,
                    url = tableModel.getValueAt(i, 1) as String,
                    publicKeyHash = tableModel.getValueAt(i, 2) as String,
                ),
            )
        }
        return result
    }

    private fun addRegistry() {
        val dialog = RegistryEditDialog(null)
        if (dialog.showAndGet()) {
            val entry = dialog.getEntry()
            tableModel.addRow(arrayOf(entry.name, entry.url, entry.publicKeyHash))
        }
    }

    private fun editRegistry() {
        val row = table.selectedRow
        if (row < 0) return
        val existing =
            RegistryEntry(
                name = tableModel.getValueAt(row, 0) as String,
                url = tableModel.getValueAt(row, 1) as String,
                publicKeyHash = tableModel.getValueAt(row, 2) as String,
            )
        val dialog = RegistryEditDialog(existing)
        if (dialog.showAndGet()) {
            val entry = dialog.getEntry()
            tableModel.setValueAt(entry.name, row, 0)
            tableModel.setValueAt(entry.url, row, 1)
            tableModel.setValueAt(entry.publicKeyHash, row, 2)
        }
    }

    private fun removeRegistry() {
        val row = table.selectedRow
        if (row < 0) return
        tableModel.removeRow(row)
    }
}

data class RegistryEntry(
    val name: String,
    val url: String,
    val publicKeyHash: String,
)

private class RegistryEditDialog(
    private val existing: RegistryEntry?,
) : DialogWrapper(true) {
    private val nameField = JBTextField(existing?.name ?: "")
    private val urlField = JBTextField(existing?.url ?: "")
    private val keyField = JBTextField(existing?.publicKeyHash ?: "")

    init {
        title = if (existing == null) "Add Registry" else "Edit Registry"
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel =
            JPanel().apply {
                layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS)
                add(JLabel("Name:"))
                add(nameField)
                add(JLabel("URL:"))
                add(urlField)
                add(JLabel("Public Key (Base64 or SHA256 fingerprint):"))
                add(keyField)
            }
        panel.preferredSize = Dimension(450, 180)
        return panel
    }

    fun getEntry() =
        RegistryEntry(
            name = nameField.text.trim(),
            url = urlField.text.trim(),
            publicKeyHash = keyField.text.trim(),
        )
}
